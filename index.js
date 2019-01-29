const chokidar = require('chokidar');
const Rsync = require('rsync');
const debounce = require('debounce');
const child_process = require('child_process');

const consoleTimestamp = require('./lib/console-timestamp');

const CONFIG = require('./config.json');

// For node 4+ support
(function () {
    'use strict';

    const synchronizers = new Map();
    const watchers = [];

    function quit() {
        consoleTimestamp.log(`\n[stopping]`);

        for (let entry of synchronizers) {
            let synchronizer = entry[1];
            consoleTimestamp.log(`[sync stop] ${synchronizer.project}`);
            synchronizer.process.kill();
        }

        for (let watcher of watchers) {
            consoleTimestamp.log(`[watch stop] ${watcher.project}`);
            watcher.watcher.close();
        }

        process.exit();
    }

    process.on('SIGINT', quit); // run signal handler on CTRL-C
    process.on('SIGTERM', quit); // run signal handler on SIGTERM

    function sync(project) {
        const rsync = new Rsync()
            .exclude(CONFIG[project].exclude || [])
            .source(CONFIG[project].from)
            .destination(CONFIG[project].to);

        for (let optionKey in (CONFIG[project].rsyncOptions || {})) {
            rsync.set(optionKey, CONFIG[project].rsyncOptions[optionKey]);
        }

        const postRemoteCommand = debounce(() => {
            console.log([CONFIG[project]['to'].split(':')[0]].concat(CONFIG[project]['postRemoteCommand']))
            // const sshProcess = child_process.spawn('ssh', [CONFIG[project]['to'].split(':')[0]].concat(CONFIG[project]['postRemoteCommand']));
            const sshProcess = child_process.spawn('lp_ssh', [CONFIG[project]['to'].split(':')[0].split('@')[1]].concat(CONFIG[project]['postRemoteCommand']));

            let stdoutOutput = '';
            let stderrOutput = '';
            sshProcess.stdout
                .on('data', (buf) => stdoutOutput += buf.toString())
                .on('end', () => consoleTimestamp.log(stdoutOutput));

            sshProcess.stderr
                .on('data', (buf) => stderrOutput += buf.toString())
                .on('end', () => consoleTimestamp.error(stderrOutput));
            
            sshProcess.on('exit', (code) => {
                console.log('exit');
                consoleTimestamp.log(`Remote command ${project} | ${CONFIG[project]['postRemoteCommand'].join(' ')} exited with status code ${code}`);

                if (stdoutOutput) {
                    consoleTimestamp.log(`Remote command stdout ${project} | ${stdoutOutput}`);
                }

                if (stderrOutput) {
                    consoleTimestamp.log(`Remote command stdout ${project} | ${stderrOutput}`);
                }
            });
            
        }, 1000);

        consoleTimestamp.log(`[sync start] ${project}`);
        return new Promise((resolve, reject) => {
            const rsyncProcess = rsync.execute((error, code, command) => {
                if (error) {
                    reject(error);
                    return;
                }

                consoleTimestamp.log(`[sync finish] ${project} | ${command}`);
                resolve(rsyncProcess.pid);
            }, (data) => {
                process.stdout.write(`[sync] ${data.toString('ascii')}`);
            });

            rsyncProcess.on('close', () => {
                synchronizers.delete(rsyncProcess.pid);
                if (CONFIG[project]['postRemoteCommand']) {
                    postRemoteCommand();
                }
            });

            synchronizers.set(rsyncProcess.pid, {project, process: rsyncProcess});
        });
    }

    function watch(project) {
        const watcher = chokidar.watch(CONFIG[project].from, {
            ignoreInitial: true,
            ignored: CONFIG[project].exclude || null,
            cwd: CONFIG[project].from,
        });
        watchers.push({project, watcher});

        const syncDebounced = debounce(() => {
            sync(project)
                .catch(error => {
                    consoleTimestamp.error(`[${project} | sync error] `, error);
                });
        }, 500);
        watcher
            .on('ready', function() {
                consoleTimestamp.log(`[watch] ${project}`);
            })
            .on('all', function(event, path) {
                consoleTimestamp.log(`[watch | ${event}] ${path}`);
                syncDebounced();
            })
            .on('error', function(error) {
                consoleTimestamp.error(`[${project} | watch error] `, error);
            });
    }

    for (let project in CONFIG) {
        sync(project).then(function() {
            watch(project);
        }).catch((error) => {
            consoleTimestamp.error(`[${project} | sync error] `, error);
        });
    }

})();
