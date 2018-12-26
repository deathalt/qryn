/*
 * Loki API to Clickhouse Gateway
 * (C) 2018-2019 QXIP BV
 * Some Rights Reserved.
 */

var debug = process.env.DEBUG || true;

/* DB Helper */
const ClickHouse = require('@apla/clickhouse');
const clickhouse_options = {
    host: process.env.CLICKHOUSE_SERVER || 'localhost',
    port: process.env.CLICKHOUSE_PORT || 8123,
    queryOptions: { database: process.env.CLICKHOUSE_DB || 'default' }
};
var clickhouse = new ClickHouse(clickhouse_options);
var ch;

/* Fingerprinting */
var shortHash = require("short-hash")
var fingerPrint = function(text,hex){
	if (hex) return shortHash(text);
	else return parseInt(shortHash(text), 16);
}
const toJSON = require('jsonic');

/* Cache Helper */
var recordCache = require('record-cache');
var onStale = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO samples(fingerprint, timestamp_ms, value, string)";
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR BULK',err);
	       if (debug) console.log ('Insert Samples complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}
var onStale_labels = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO time_series(date, fingerprint, labels)";
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR BULK',err);
	       if (debug) console.log ('Insert Labels complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}

// Flushing to Clickhouse
var bulk = recordCache({
  maxSize: 5000,
  maxAge: 2000,
  onStale: onStale
})
var bulk_labels = recordCache({
  maxSize: 100,
  maxAge: 500,
  onStale: onStale_labels
})

// In-Memory LRU for quick lookups
var labels = recordCache({
  maxSize: 50000,
  maxAge: 0,
  onStale: false
})

/* Function Helpers */
var databaseName;
var initialize = function(dbName){
	var dbQuery = "CREATE DATABASE IF NOT EXISTS "+dbName;
	clickhouse.query(dbQuery, function (err, data) {
		if (err) return err;
		databaseName = dbName;
		clickhouse_options.queryOptions.database = dbName;
		ch = new ClickHouse(clickhouse_options);
		var ts_table = "CREATE TABLE IF NOT EXISTS "+dbName+".time_series (date Date,fingerprint UInt64,labels String) ENGINE = ReplacingMergeTree PARTITION BY date ORDER BY fingerprint"
		var sm_table = "CREATE TABLE IF NOT EXISTS "+dbName+".samples (fingerprint UInt64,timestamp_ms Int64,value Float64,string String) ENGINE = MergeTree PARTITION BY toDate(timestamp_ms / 1000) ORDER BY (fingerprint, timestamp_ms)"

	  	ch.query(ts_table, function(err,data){
			if (err) return err;
			if (debug) console.log('Timeseries Table ready!');
			return true;
		});
	  	ch.query(sm_table, function(err,data){
			if (err) return err;
			if (debug) console.log('Samples Table ready!');
			return true;
		});
	});
};

initialize(process.env.CLICKHOUSE_TSDB || 'loki');

/* Fastify Helper */

const fastify = require('fastify')({
  logger: false
})

// Declare a route
fastify.get('/', (request, reply) => {
  reply.send({ hello: 'loki' })
})

/* Write Handler */
/*
    Accepts JSON formatted requests when the header Content-Type: application/json is sent.
    Example of the JSON format:

	{
	    "streams": [
	        {
	            "labels": "{foo=\"bar\"}",
	            "entries": [
	                {"ts": "2018-12-18T08:28:06.801064-04:00", "line": "baz"}
	            ]
	        }
	    ]
	}
*/
fastify.post('/api/prom/push', (req, res) => {
  if (debug) console.log('POST /api/prom/push');
  if (debug) console.log('QUERY: ', req.query);
  if (debug) console.log('BODY: ', req.body);
  if (req.body.streams) {
	req.body.streams.forEach(function(stream){
		try {
			var JSON_labels = toJSON(stream.labels.replace('=',':'));
			// Calculate Fingerprint
			var finger = fingerPrint(JSON_labels);
			if (debug) console.log('LABELS',stream.labels,finger);
			labels.add(finger,stream.labels);
			// Store Fingerprint
 			bulk_labels.add(finger,[new Date().toISOString().split('T')[0], finger, JSON.stringify(JSON_labels)]);
			for(var key in JSON_labels) {
			   if (debug) console.log('Storing label',key, JSON_labels[key]);
			   labels.add('_LABELS_',key); labels.add(key, JSON_labels[key]);
			}
		} catch(e) { console.log(e) }

		if (stream.entries) {
			stream.entries.forEach(function(entry){
				var values = [ finger, new Date(entry.timestamp).getTime(), entry.value || 0, entry.line || "" ];
				bulk.add(finger,values);
			})
		}
	});
  }
  res.send(200);
});


/* Query Handler */
/*
   For doing queries, accepts the following parameters in the query-string:

	query: a logQL query
	limit: max number of entries to return
	start: the start time for the query, as a nanosecond Unix epoch (nanoseconds since 1970)
	end: the end time for the query, as a nanosecond Unix epoch (nanoseconds since 1970)
	direction: forward or backward, useful when specifying a limit
	regexp: a regex to filter the returned results, will eventually be rolled into the query language
*/
fastify.get('/api/prom/query', (req, res) => {
  if (debug) console.log('GET /api/prom/query');
  if (debug) console.log('QUERY: ', req.query);
  var params = req.query;
  var resp = { "streams": [] };
  var JSON_labels = toJSON(req.query.query.replace('=',':'));
  var finger = fingerPrint(JSON_labels);
  var select_query = "SELECT fingerprint, timestamp_ms, string"
		+ " FROM samples"
		+ " WHERE fingerprint IN ("+finger+")"
		+ " ORDER BY fingerprint, timestamp_ms"
  var stream = ch.query(select_query);
  // or collect records yourself
	var rows = [];
	stream.on ('metadata', function (columns) {
	  // do something with column list
	});
	stream.on ('data', function (row) {
	  rows.push (row);
	});
	stream.on ('error', function (err) {
	  // TODO: handler error
	});
	stream.on ('end', function () {
	  if (debug) console.log('RESPONSE:',rows);
	  var entries = [];
	  rows.forEach(function(row){
		entries.push({ "timestamp": row[1], "line": row[2] })
	  });
  	  resp.streams.push( { "labels": JSON.stringify(JSON_labels), "entries": entries }  );
  	  res.send(resp);

	});

});


/* Label Handlers */
/*
   For retrieving the names of the labels one can query on.
   Responses looks like this:

	{
	  "values": [
	    "instance",
	    "job",
	    ...
	  ]
	}
*/

fastify.get('/api/prom/label', (req, res) => {
  if (debug) console.log('GET /api/prom/label');
  if (debug) console.log('QUERY: ', req.query);
  var all_labels = labels.get('_LABELS_');
  var resp = { "values": all_labels };
  // resp.values.push("foo");
  res.send(resp);
});

/* Label Value Handler */
/*
   For retrieving the label values one can query on.
   Responses looks like this:

	{
	  "values": [
	    "default",
	    "cortex-ops",
	    ...
	  ]
	}
*/
fastify.get('/api/prom/label/:name/values', (req, res) => {
  if (debug) console.log('GET /api/prom/label/'+req.params.name+'/values');
  if (debug) console.log('QUERY LABEL: ', req.params.name);
  var all_values = labels.get(req.params.name);
  var resp = { "values": all_values };
  //resp.values.push("bar");
  res.send(resp);
});



// Run the server!
fastify.listen(process.env.PORT || 3000, (err, address) => {
  if (err) throw err
  fastify.log.info(`server listening on ${address}`)
})