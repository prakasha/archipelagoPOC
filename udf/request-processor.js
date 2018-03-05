/*
	This file is a node.js module.

	This is a sample implementation of UDF-compatible datafeed wrapper for Quandl (historical data) and yahoo.finance (quotes).
	Some algorithms may be incorrect because it's rather an UDF implementation sample
	then a proper datafeed implementation.
*/

/* global require */
/* global console */
/* global exports */
/* global process */

"use strict";

var https = require("https");
var http = require("http");

var quandlCache = {};

var quandlCacheCleanupTime = 3 * 60 * 60 * 100; // 3 hours
var yahooFailedStateCacheTime = 3 * 60 * 60 * 100; // 3 hours;
var quandlMinimumDate = '1970-01-01';

// this cache is intended to reduce number of requests to Quandl
setInterval(function () {
	quandlCache = {};
}, quandlCacheCleanupTime);

function dateForLogs() {
	return (new Date()).toISOString() + ': ';
}

var defaultResponseHeader = {
	"Content-Type": "text/plain",
	'Access-Control-Allow-Origin': '*'
};

function sendJsonResponse(response, jsonData) {
	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(jsonData));
	response.end();
}

function dateToYMD(date) {
	var obj = new Date(date);
	var year = obj.getFullYear();
	var month = obj.getMonth() + 1;
	var day = obj.getDate();
	return year + "-" + month + "-" + day;
}

function httpGet(datafeedHost, path, callback) {
	var options = {
		host: datafeedHost,
		path: path
	};

	function onDataCallback(response) {
		var result = '';

		response.on('data', function (chunk) {
			result += chunk;
		});

		response.on('end', function () {
			if (response.statusCode !== 200) {
				callback('');
				return;
			}

			callback(result);
		});
	}

	var req = https.request(options, onDataCallback);

	req.on('socket', function (socket) {
		socket.setTimeout(5000);
		socket.on('timeout', function () {
			console.log('timeout');
			req.abort();
		});
	});

	req.on('error', function (e) {
		console.log('Problem with request: ' + e.message);
		callback('');
	});

	req.end();
}

function convertQuandlHistoryToUDFFormat(data) {
	function parseDate(input) {
		var parts = input.split('-');
		return Date.UTC(parts[0], parts[1] - 1, parts[2]);
	}

	function columnIndices(columns) {
		var indices = {};
		for (var i = 0; i < columns.length; i++) {
			indices[columns[i].name] = i;
		}

		return indices;
	}

	var result = {
		t: [],
		c: [],
		o: [],
		h: [],
		l: [],
		v: [],
		s: "ok"
	};

	try {
		var json = JSON.parse(data);
		var datatable = json.datatable;
		var idx = columnIndices(datatable.columns);

		datatable.data.forEach(function (row) {
			result.t.push(parseDate(row[idx.date]) / 1000);
			result.o.push(row[idx.open]);
			result.h.push(row[idx.high]);
			result.l.push(row[idx.low]);
			result.c.push(row[idx.close]);
			result.v.push(row[idx.volume]);
		});

	} catch (error) {
		var dataStr = typeof data === "string" ? data.slice(0, 100) : data;
		console.error(dateForLogs() + error + ", failed to parse: " + dataStr);
	}

	return result;
}

function convertYahooQuotesToUDFFormat(tickersMap, data) {
	if (!data.query || !data.query.results) {
		var errmsg = "ERROR: empty quotes response: " + JSON.stringify(data);
		console.log(errmsg);
		return {
			s: "error",
			errmsg: errmsg
		};
	}

	var result = {
		s: "ok",
		d: []
	};

	[].concat(data.query.results.quote).forEach(function (quote) {
		var ticker = tickersMap[quote.symbol];

		// this field is an error token
		if (quote["ErrorIndicationreturnedforsymbolchangedinvalid"] || !quote.StockExchange) {
			result.d.push({
				s: "error",
				n: ticker,
				v: {}
			});
			return;
		}

		result.d.push({
			s: "ok",
			n: ticker,
			v: {
				ch: +(quote.ChangeRealtime || quote.Change),
				chp: +((quote.PercentChange || quote.ChangeinPercent) && (quote.PercentChange || quote.ChangeinPercent).replace(/[+-]?(.*)%/, "$1")),

				short_name: quote.Symbol,
				exchange: quote.StockExchange,
				original_name: quote.StockExchange + ":" + quote.Symbol,
				description: quote.Name,

				lp: +quote.LastTradePriceOnly,
				ask: +quote.AskRealtime,
				bid: +quote.BidRealtime,

				open_price: +quote.Open,
				high_price: +quote.DaysHigh,
				low_price: +quote.DaysLow,
				prev_close_price: +quote.PreviousClose,
				volume: +quote.Volume,
			}
		});
	});
	return result;
}

function proxyRequest(controller, options, response) {
	controller.request(options, function (res) {
		var result = '';

		res.on('data', function (chunk) {
			result += chunk;
		});

		res.on('end', function () {
			if (res.statusCode !== 200) {
				response.writeHead(200, defaultResponseHeader);
				response.write(JSON.stringify({
					s: 'error',
					errmsg: 'Failed to get news'
				}));
				response.end();
				return;
			}
			response.writeHead(200, defaultResponseHeader);
			response.write(result);
			response.end();
		});
	}).end();
}

function RequestProcessor(symbolsDatabase) {
	this._symbolsDatabase = symbolsDatabase;
	this._failedYahooTime = {};
}

function filterDataPeriod(data, fromSeconds, toSeconds) {
	if (!data || !data.t) {
		return data;
	}

	var fromIndex = null;
	var toIndex = null;
	var times = data.t;
	for (var i = 0; i < times.length; i++) {
		var time = times[i];
		if (fromIndex === null && time >= fromSeconds) {
			fromIndex = i;
		}
		if (toIndex === null && time >= toSeconds) {
			toIndex = time > toSeconds ? i - 1 : i;
		}
		if (fromIndex !== null && toIndex !== null) {
			break;
		}
	}

	fromIndex = fromIndex || 0;
	toIndex = toIndex ? toIndex + 1 : times.length;

	var s = data.s;

	if (toSeconds < times[0]) {
		s = 'no_data';
	}

	return {
		t: data.t.slice(fromIndex, toIndex),
		o: data.o.slice(fromIndex, toIndex),
		h: data.h.slice(fromIndex, toIndex),
		l: data.l.slice(fromIndex, toIndex),
		c: data.c.slice(fromIndex, toIndex),
		v: data.v.slice(fromIndex, toIndex),
		s: s
	};
}

RequestProcessor.prototype._sendError = function (error, response) {
	response.writeHead(200, defaultResponseHeader);
	response.write("{\"s\":\"error\",\"errmsg\":\"" + error + "\"}");
	response.end();

	console.log(error);
};


RequestProcessor.prototype._sendConfig = function (response) {

	var config = {
		supports_search: true,
		supports_group_request: false,
		supports_marks: true,
		supports_timescale_marks: true,
		supports_time: true,
		exchanges: [
			{
				value: "",
				name: "All Exchanges",
				desc: ""
			},
			{
				value: "NasdaqNM",
				name: "NasdaqNM",
				desc: "NasdaqNM"
			},
			{
				value: "NYSE",
				name: "NYSE",
				desc: "NYSE"
			},
			{
				value: "NCM",
				name: "NCM",
				desc: "NCM"
			},
			{
				value: "NGM",
				name: "NGM",
				desc: "NGM"
			},
		],
		symbols_types: [
			{
				name: "All types",
				value: ""
			},
			{
				name: "Stock",
				value: "stock"
			},
			{
				name: "Index",
				value: "index"
			}
		],
		supported_resolutions: ["D", "2D", "3D", "W", "3W", "M", '6M']
	};

	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(config));
	response.end();
};


RequestProcessor.prototype._sendMarks = function (response) {
	var now = new Date();
	now = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 1000;
	var day = 60 * 60 * 24;

	var marks = {
		id: [0, 1, 2, 3, 4, 5],
		time: [now, now - day * 4, now - day * 7, now - day * 7, now - day * 15, now - day * 30],
		color: ["red", "blue", "green", "red", "blue", "green"],
		text: ["Today", "4 days back", "7 days back + Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.", "7 days back once again", "15 days back", "30 days back"],
		label: ["A", "B", "CORE", "D", "EURO", "F"],
		labelFontColor: ["white", "white", "red", "#FFFFFF", "white", "#000"],
		minSize: [14, 28, 7, 40, 7, 14]
	};

	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(marks));
	response.end();
};

RequestProcessor.prototype._sendTime = function (response) {
	var now = new Date();
	response.writeHead(200, defaultResponseHeader);
	response.write(Math.floor(now / 1000) + '');
	response.end();
};

RequestProcessor.prototype._sendTimescaleMarks = function (response) {
	var now = new Date();
	now = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 1000;
	var day = 60 * 60 * 24;

	var marks = [
		{
			id: "tsm1",
			time: now,
			color: "red",
			label: "A",
			tooltip: ""
		},
		{
			id: "tsm2",
			time: now - day * 4,
			color: "blue",
			label: "D",
			tooltip: ["Dividends: $0.56", "Date: " + new Date((now - day * 4) * 1000).toDateString()]
		},
		{
			id: "tsm3",
			time: now - day * 7,
			color: "green",
			label: "D",
			tooltip: ["Dividends: $3.46", "Date: " + new Date((now - day * 7) * 1000).toDateString()]
		},
		{
			id: "tsm4",
			time: now - day * 15,
			color: "#999999",
			label: "E",
			tooltip: ["Earnings: $3.44", "Estimate: $3.60"]
		},
		{
			id: "tsm7",
			time: now - day * 30,
			color: "red",
			label: "E",
			tooltip: ["Earnings: $5.40", "Estimate: $5.00"]
		},
	];

	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(marks));
	response.end();
};


RequestProcessor.prototype._sendSymbolSearchResults = function (query, type, exchange, maxRecords, response) {
	if (!maxRecords) {
		throw "wrong_query";
	}

	var result = this._symbolsDatabase.search(query, type, exchange, maxRecords);

	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(result));
	response.end();
};

RequestProcessor.prototype._prepareSymbolInfo = function (symbolName) {
	var symbolInfo = this._symbolsDatabase.symbolInfo(symbolName);

	if (!symbolInfo) {
		throw "unknown_symbol " + symbolName;
	}

	return {
		"name": symbolInfo.name,
		"exchange-traded": symbolInfo.exchange,
		"exchange-listed": symbolInfo.exchange,
		"timezone": "America/New_York",
		"minmov": 1,
		"minmov2": 0,
		"pointvalue": 1,
		"session": "0930-1630",
		"has_intraday": false,
		"has_no_volume": symbolInfo.type !== "stock",
		"description": symbolInfo.description.length > 0 ? symbolInfo.description : symbolInfo.name,
		"type": symbolInfo.type,
		"supported_resolutions": ["D", "2D", "3D", "W", "3W", "M", "6M"],
		"pricescale": 100,
		"ticker": symbolInfo.name.toUpperCase()
	};
};

RequestProcessor.prototype._sendSymbolInfo = function (symbolName, response) {
	var info = this._prepareSymbolInfo(symbolName);

	response.writeHead(200, defaultResponseHeader);
	response.write(JSON.stringify(info));
	response.end();
};

RequestProcessor.prototype._sendSymbolHistory = function (symbol, startDateTimestamp, endDateTimestamp, resolution, response) {
	function sendResult(content) {
		var header = Object.assign({}, defaultResponseHeader);
		header["Content-Length"] = content.length;
		response.writeHead(200, header);
		response.write(content, null, function () {
			response.end();
		});
	}

	function secondsToISO(sec) {
		if (sec === null || sec === undefined) {
			return 'n/a';
		}
		return (new Date(sec * 1000).toISOString());
	}

	function logForData(data, key, isCached) {
		var fromCacheTime = data && data.t ? data.t[0] : null;
		var toCacheTime = data && data.t ? data.t[data.t.length - 1] : null;
		console.log(dateForLogs() + "Return QUANDL result" + (isCached ? " from cache" : "") + ": " + key + ", from " + secondsToISO(fromCacheTime) + " to " + secondsToISO(toCacheTime));
	}

	console.log(dateForLogs() + "Got history request for " + symbol + ", " + resolution + " from " + secondsToISO(startDateTimestamp)+ " to " + secondsToISO(endDateTimestamp));

	// always request all data to reduce number of requests to quandl
	var from = quandlMinimumDate;
	var to = dateToYMD(Date.now());

	var key = symbol + "|" + from + "|" + to;

	if (quandlCache[key]) {
		var dataFromCache = filterDataPeriod(quandlCache[key], startDateTimestamp, endDateTimestamp);
		logForData(dataFromCache, key, true);
		sendResult(JSON.stringify(dataFromCache));
		return;
	}

	var address = "/api/v3/datatables/WIKI/PRICES.json" +
		"?api_key=" + process.env.QUANDL_API_KEY + // you should create a free account on quandl.com to get this key
		"&ticker=" + symbol +
		"&date.gte=" + from +
		"&date.lte=" + to;

	console.log(dateForLogs() + "Sending request to quandl  " + key + ". url=" + address);

	httpGet("www.quandl.com", address, function (result) {
		if (response.finished) {
			// we can be here if error happened on socket disconnect
			return;
		}
		console.log(dateForLogs() + "Got response from quandl  " + key + ". Try to parse.");
		var data = convertQuandlHistoryToUDFFormat(result);
		if (data.t.length !== 0) {
			console.log(dateForLogs() + "Successfully parsed and put to cache " + data.t.length + " bars.");
			quandlCache[key] = data;
		} else {
			console.warn(dateForLogs() + "Parsing returned empty result.");
		}
		var filteredData = filterDataPeriod(data, startDateTimestamp, endDateTimestamp);
		logForData(filteredData, key, false);
		sendResult(JSON.stringify(filteredData));
	});
};

RequestProcessor.prototype._quotesQuandlWorkaround = function (tickersMap) {
	var from = quandlMinimumDate;
	var to = dateToYMD(Date.now());

	var result = {
		s: "ok",
		d: [],
		source: 'Quandl',
	};

	Object.keys(tickersMap).forEach(function(symbol) {
		var key = symbol + "|" + from + "|" + to;
		var ticker = tickersMap[symbol];

		var data = quandlCache[key];
		var length = data === undefined ? 0 : data.c.length;

		if (length > 0) {
			var lastBar = {
				o: data.o[length - 1],
				h: data.o[length - 1],
				l: data.o[length - 1],
				c: data.o[length - 1],
				v: data.o[length - 1],
			};

			result.d.push({
				s: "ok",
				n: ticker,
				v: {
					ch: 0,
					chp: 0,

					short_name: symbol,
					exchange: '',
					original_name: ticker,
					description: ticker,

					lp: lastBar.c,
					ask: lastBar.c,
					bid: lastBar.c,

					open_price: lastBar.o,
					high_price: lastBar.h,
					low_price: lastBar.l,
					prev_close_price: length > 1 ? data.c[length - 2] : lastBar.o,
					volume: lastBar.v,
				}
			});
		}
	});

	return result;
};

RequestProcessor.prototype._sendQuotes = function (tickersString, response) {
	var tickersMap = {}; // maps YQL symbol to ticker

	var tickers = tickersString.split(",");
	[].concat(tickers).forEach(function (ticker) {
		var yqlSymbol = ticker.replace(/.*:(.*)/, "$1");
		tickersMap[yqlSymbol] = ticker;
	});

	if (this._failedYahooTime[tickersString] && Date.now() - this._failedYahooTime[tickersString] < yahooFailedStateCacheTime) {
		sendJsonResponse(response, this._quotesQuandlWorkaround(tickersMap));
		console.log("Quotes request : " + tickersString + ' processed from quandl cache');
		return;
	}

	var that = this;

	var yql = "env 'store://datatables.org/alltableswithkeys'; select * from yahoo.finance.quotes where symbol in ('" + Object.keys(tickersMap).join("','") + "')";
	console.log("Quotes query: " + yql);

	var options = {
		host: "query.yahooapis.com",
		path: "/v1/public/yql?q=" + encodeURIComponent(yql) +
		"&format=json" +
		"&env=store://datatables.org/alltableswithkeys"
	};
	// for debug purposes
	// console.log(options.host + options.path);

	http.request(options, function (res) {
		var result = '';

		res.on('data', function (chunk) {
			result += chunk;
		});

		res.on('end', function () {
			var jsonResponse = { s: 'error' };

			if (res.statusCode === 200) {
				jsonResponse = convertYahooQuotesToUDFFormat(tickersMap, JSON.parse(result));
			} else {
				console.error('Yahoo Fails with code ' + res.statusCode);
			}

			if (jsonResponse.s === 'error') {
				that._failedYahooTime[tickersString] = Date.now();
				jsonResponse = that._quotesQuandlWorkaround(tickersMap);
				console.log("Quotes request : " + tickersString + ' processed from quandl');
			}

			sendJsonResponse(response, jsonResponse);
		});
	}).end();
};

RequestProcessor.prototype._sendNews = function (symbol, response) {
	var options = {
		host: "feeds.finance.yahoo.com",
		path: "/rss/2.0/headline?s=" + symbol + "&region=US&lang=en-US"
	};

	proxyRequest(https, options, response);
};

RequestProcessor.prototype._sendFuturesmag = function (response) {
	var options = {
		host: "www.futuresmag.com",
		path: "/rss/all"
	};

	proxyRequest(http, options, response);
};

RequestProcessor.prototype.processRequest = function (action, query, response) {
	try {
		if (action === "/config") {
			this._sendConfig(response);
		}
		else if (action === "/symbols" && !!query["symbol"]) {
			this._sendSymbolInfo(query["symbol"], response);
		}
		else if (action === "/search") {
			this._sendSymbolSearchResults(query["query"], query["type"], query["exchange"], query["limit"], response);
		}
		else if (action === "/history") {
			this._sendSymbolHistory(query["symbol"], query["from"], query["to"], query["resolution"].toLowerCase(), response);
		}
		else if (action === "/quotes") {
			this._sendQuotes(query["symbols"], response);
		}
		else if (action === "/marks") {
			this._sendMarks(response);
		}
		else if (action === "/time") {
			this._sendTime(response);
		}
		else if (action === "/timescale_marks") {
			this._sendTimescaleMarks(response);
		}
		else if (action === "/news") {
			this._sendNews(query["symbol"], response);
		}
		else if (action === "/futuresmag") {
			this._sendFuturesmag(response);
		} else {
			response.writeHead(200, defaultResponseHeader);
			response.write('datafeed is ok');
			response.end();
		}
	}
	catch (error) {
		this._sendError(error, response);
	}
};

exports.RequestProcessor = RequestProcessor;
