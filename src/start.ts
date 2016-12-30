/**
 * Tsserver proxy
 */

import { ChildProcess, execSync, spawn } from 'child_process';
import { createServer, Socket } from 'net';
import { join } from 'path';
import { unlink, statSync } from 'fs';
import { debug, error, log, print } from './lib/log';
import { MessageHandler } from './lib/messages';
import { getSocketFile } from './lib/connect';

function commandExists(command: string) {
	try {
		const checker = process.platform === 'win32' ? 'where' : 'command -v';
		execSync(`${checker} ${command}`);
		return true;
	}
	catch (err) {
		return false;
	}
}

function fileExists(filename: string) {
	try {
		statSync(filename);
		return true;
	}
	catch (err) {
		return false;
	}
}

function startTsserver() {
	tsserver = spawn(serverBin);
	log('Started tsserver');

	// Pipe this process's stdin to the running tsserver's
	process.stdin.pipe(tsserver.stdin);

	tsserver.on('exit', function () {
		// If tsserver is exiting because the user asked it to, this process
		// should also end
		if (exiting) {
			process.exit(0);
		}
		else {
			tsserver.removeAllListeners();
			tsserver = null;

			// Respawn the server
			startTsserver();
		}
	});

	tsserver.on('error', err => {
		error(`Server error: ${err}`);
	});

	tsserver.stdout.on('data', data => {
		print(data);
		clients.forEach(client => client.write(data));
	});

	tsserver.stderr.on('data', data => {
		log(data);
	});
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.on('exit', () => {
	if (tsserver) {
		tsserver.kill();
	}
	// Ensure socket file is removed when process exits
	unlink(socketFile, _err => {});
});

let exiting = false;
let tsserver: ChildProcess;

let serverBin = process.argv[2];

if (!serverBin) {
	if (!fileExists(serverBin)) {
		// Try project
		serverBin = join('node_modules', '.bin', 'tsserver');
	}

	if (!fileExists(serverBin)) {
		// Try global
		serverBin = 'tsserver';
	}

	if (!commandExists(serverBin)) {
		// Try plugin
		serverBin = join(__dirname, '..', 'node_modules', '.bin', 'tsserver');
	}

	if (!fileExists(serverBin)) {
		error(`Couldn't find a copy of tsserver`);
		process.exit(1);
	}
}

const socketFile = getSocketFile(process.cwd());
const clients: Socket[] = [];
const loggers: Socket[] = [];

startTsserver();

const server = createServer(client => {
	debug('Added client');
	clients.push(client);

	const clientHandler = new MessageHandler(client);

	clientHandler.on('request', request => {
		debug('Received request', request);

		switch (request.command) {
		case 'exit':
			exiting = true;
			break;
		case 'logger':
			loggers.push(client);
			debug('Added logger');
			return;
		}

		const message = `${JSON.stringify(request)}\n`;
		tsserver.stdin.write(message);
		loggers.forEach(logger => {
			logger.write(message);
		});
	});

	client.on('end', () => {
		clients.splice(clients.indexOf(client, 1));
		debug('Removed client');

		const logger = loggers.indexOf(client);
		if (logger !== -1) {
			loggers.splice(logger, 1);
			debug('Removed logger');
		}
	});
});

server.on('error', function (err) {
	error(`Error: ${err}`);
	process.exit(1);
});

server.listen(socketFile, () => {
	log(`Listening on ${socketFile}...`);
});
