// Headless QUnit runner for the jQuery 1.11.x test suite.
//
// Drives a headless Chrome over the DevTools protocol with nothing but the
// Node standard library (global fetch + WebSocket, Node >= 18), so the CI leg
// needs no npm install of its own.
//
// Usage: node qunit-run.js <url> [chrome-binary]

"use strict";

var url = process.argv[ 2 ];
var chromeBin = process.argv[ 3 ] || process.env.CHROME_BIN || "google-chrome";
var TIMEOUT_MS = Number( process.env.QUNIT_TIMEOUT_MS || 900000 );
var PORT = Number( process.env.QUNIT_CDP_PORT || 9222 );

var spawn = require( "child_process" ).spawn;
var os = require( "os" );
var fs = require( "fs" );
var path = require( "path" );

function sleep( ms ) {
	return new Promise( function( resolve ) {
		setTimeout( resolve, ms );
	} );
}

async function main() {
	if ( !url ) {
		throw new Error( "usage: node qunit-run.js <url> [chrome-binary]" );
	}

	var profile = fs.mkdtempSync( path.join( os.tmpdir(), "qunit-chrome-" ) );
	var chrome = spawn( chromeBin, [
		"--headless=new",
		"--disable-gpu",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--hide-scrollbars",

		// The suite's testIframeWithCallback tests race when Chrome throttles
		// timers in hidden/backgrounded frames, so keep every frame live.
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-ipc-flooding-protection",
		"--window-size=1280,1024",
		"--force-device-scale-factor=1",
		"--remote-debugging-port=" + PORT,
		"--user-data-dir=" + profile,
		"about:blank"
	], { stdio: [ "ignore", "pipe", "pipe" ] } );

	chrome.stderr.on( "data", function() {} );

	var target = null;
	for ( var i = 0; i < 60 && !target; i++ ) {
		await sleep( 500 );
		try {
			var res = await fetch( "http://127.0.0.1:" + PORT + "/json/new?" +
				encodeURIComponent( url ), { method: "PUT" } );
			target = await res.json();
		} catch ( e ) {
			target = null;
		}
	}
	if ( !target || !target.webSocketDebuggerUrl ) {
		chrome.kill();
		throw new Error( "could not open a DevTools target on port " + PORT );
	}

	var ws = new WebSocket( target.webSocketDebuggerUrl );
	var nextId = 1;
	var pending = new Map();

	ws.addEventListener( "message", function( ev ) {
		var msg = JSON.parse( ev.data );
		if ( msg.id && pending.has( msg.id ) ) {
			pending.get( msg.id )( msg );
			pending.delete( msg.id );
		}
	} );
	await new Promise( function( resolve, reject ) {
		ws.addEventListener( "open", resolve );
		ws.addEventListener( "error", reject );
	} );

	function send( method, params ) {
		var id = nextId++;
		return new Promise( function( resolve ) {
			pending.set( id, resolve );
			ws.send( JSON.stringify( { id: id, method: method, params: params || {} } ) );
		} );
	}

	async function evaluate( expression ) {
		var msg = await send( "Runtime.evaluate", {
			expression: expression,
			returnByValue: true,
			awaitPromise: false
		} );
		if ( msg.result && msg.result.exceptionDetails ) {
			return null;
		}
		return msg.result && msg.result.result ? msg.result.result.value : null;
	}

	// The suite reports completion by writing into #qunit-testresult. Poll for
	// it and keep a heartbeat on the log so a CI leg never looks hung.
	var deadline = Date.now() + TIMEOUT_MS;
	var summary = null;
	var lastSeen = "";
	while ( Date.now() < deadline ) {
		await sleep( 5000 );
		summary = await evaluate(
			"(function(){var e=document.getElementById('qunit-testresult');" +
			"return e?e.textContent:'';})()"
		);
		if ( summary && /assertions of/.test( summary ) ) {
			break;
		}
		var progress = await evaluate(
			"(function(){var e=document.getElementById('qunit-testresult');" +
			"return e?e.textContent:(window.QUnit?'QUnit loaded, running':'loading');})()"
		) || "";
		if ( progress !== lastSeen ) {
			lastSeen = progress;
			console.log( "... " + progress.slice( 0, 160 ) );
		}
	}

	if ( !summary || !/assertions of/.test( summary ) ) {
		var diag = await evaluate(
			"(function(){return document.body?document.body.textContent.slice(0,2000):'no body';})()"
		);
		chrome.kill();
		throw new Error( "QUnit never completed within " + TIMEOUT_MS + "ms.\n" +
			"last state: " + lastSeen + "\npage text: " + diag );
	}

	var failures = await evaluate(
		"(function(){var out=[];" +
		"var items=document.querySelectorAll('#qunit-tests > li.fail');" +
		"for(var i=0;i<items.length;i++){" +
		"var m=items[i].querySelector('.module-name');" +
		"var t=items[i].querySelector('.test-name');" +
		"out.push((m?m.textContent+': ':'')+(t?t.textContent:'(unnamed)'));}" +
		"return out.join('\\n');})()"
	) || "";

	console.log( "\n==== QUnit summary ====" );
	console.log( summary );
	if ( failures ) {
		console.log( "\n==== failing tests ====" );
		console.log( failures );
	}

	chrome.kill();

	var failed = /(\d+) failed/.exec( summary );
	var failedCount = failed ? Number( failed[ 1 ] ) : 1;
	if ( failedCount > 0 ) {
		console.error( "\nQUnit reported " + failedCount + " failed assertion(s)." );
		process.exit( 1 );
	}
	console.log( "\nQUnit suite passed." );
	process.exit( 0 );
}

main().catch( function( err ) {
	console.error( err && err.stack || String( err ) );
	process.exit( 1 );
} );
