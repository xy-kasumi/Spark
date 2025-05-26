// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

Vue.createApp({
    data() {
        return {
            command_text: '',
            spooler_status: 'Unknown',
            core_status: 'Unknown',
            log_output: '',
            exec_status: '',
            xp: 0,
            yp: 0,
            zp: 0,
        }
    },
    computed: {
        commands() {
            return this.command_text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        },
    },
    methods: {
        async refresh() {
            try {
                const res = await fetch(host + '/status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const text = await res.text();
                if (!res.ok) {
                    this.spooler_status = 'Connected (Error; No JSON)';
                    return;
                }
                const respJson = JSON.parse(text);
                this.spooler_status = 'Connected';
                this.core_status = respJson.status;
                this.xp = respJson.x_pos;
                this.yp = respJson.y_pos;
                this.zp = respJson.z_pos;
            } catch (err) {
                this.spooler_status = 'Failed to connect';
                return;
            }

            const res = await fetch(host + '/get-core-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const text = await res.text();
            if (!res.ok) {
                return;
            }
            const respJson = JSON.parse(text);
            this.log_output = respJson.output;
            this.$nextTick(() => {
                this.$refs.logOutput.scrollTop = this.$refs.logOutput.scrollHeight;
            });
        },
        async init() {
            try {
                const res = await fetch(host + '/init', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const text = await res.text();
                if (!res.ok) throw new Error(text);
                this.status = 'Success: ' + text;
            } catch (err) {
                this.status = 'Error: ' + err.message;
            }
            await this.refresh();
        },
        async send() {
            this.exec_status = 'executing...';
            try {
                const res = await fetch(host + '/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ commands: this.commands })
                });
                const text = await res.text();
                if (!res.ok) {
                    throw new Error(text);
                }
                const respJson = JSON.parse(text);
                if (respJson.error) {
                    this.exec_status = "Command Error: " + respJson.error;
                    return;
                }
                if (!respJson.command_success) {
                    const errorLocs = [];
                    for (let i = 0; i < respJson.command_errors.length; i++) {
                        const err = respJson.command_errors[i];
                        if (err === null) continue;
                        errorLocs.push(`${commands[i]}: ${err}`);
                    }
                    this.exec_status = "Command Failed: " + errorLocs.join(', ');;
                    return;
                }
                this.exec_status = "Success";
            } catch (err) {
                this.exec_status = '';
                this.spooler_status = 'Error: ' + err.message;
            }
            await this.refresh();
        },
        async cancel() {
            try {
                this.exec_status = 'Sending Ctrl-Y...';
                const res = await fetch(host + '/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ commands: ['\x19'] })
                });
                const text = await res.text();
                if (!res.ok) {
                    throw new Error(text);
                }
                const respJson = JSON.parse(text);
                if (respJson.error) {
                    this.exec_status = "Command Error: " + respJson.error;
                    return;
                }
                if (!respJson.command_success) {
                    const errorLocs = [];
                    for (let i = 0; i < respJson.command_errors.length; i++) {
                        const err = respJson.command_errors[i];
                        if (err === null) continue;
                        errorLocs.push(`${commands[i]}: ${err}`);
                    }
                    this.exec_status = "Command Failed: " + errorLocs.join(', ');;
                    return;
                }
                this.exec_status = "Success";
            } catch (err) {
                this.exec_status = '';
                this.spooler_status = 'Error: ' + err.message;
            }
            await this.refresh();
        },
        analyze_log() {
            let outputLines = this.log_output.split('\n').map(line => {
                const ix = line.indexOf('>');
                if (ix < 0) {
                    return null;
                }
                return line.slice(ix + 1)
            }).filter(line => line !== null);

            // remove last non-EDML lines
            const lastLogIx = outputLines.findLastIndex(line => line.startsWith("[EDML|"));
            if (lastLogIx < 0) {
                // no EDML found
                return;
            }
            outputLines = outputLines.slice(0, lastLogIx + 1);

            // remove all lines before the continuous EDML segment
            const lastNonLogIx = outputLines.findLastIndex(line => !line.startsWith("[EDML|"));
            outputLines = outputLines.slice(lastNonLogIx + 1);

            // process log
            const edmlData = outputLines.map(line => {
                const elems = line.replace("[EDML|", "").replace("]", "").split(",");
                const numPulses = parseInt(elems.at(-1));
                const state = elems.at(-2);
                const vals = elems.slice(0, -2).map(val => ({ pulse: parseInt(val[0]) * 0.1, short: parseInt(val[1]) * 0.1 }));
                return {
                    state: state,
                    numPulses: numPulses,
                    vals: vals
                }
            });
            console.log(edmlData);

            // draw
            const ctx = this.$refs.edml.getContext('2d');
            //ctx.save();
            const width = 500;
            const height = 1000;
            const barWidth = 2;
            const barHeight = 20;
            ctx.clearRect(0, 0, width, height);

            let posx = 0;
            let posy = 0;
            for (let row of edmlData) {
                for (let val of row.vals) {
                    let d = 0;
                    ctx.fillStyle = '#00aeef';
                    ctx.fillRect(posx, posy + barHeight, barWidth, -val.pulse * barHeight);
                    d += val.pulse * barHeight;

                    ctx.fillStyle = '#F03266';
                    ctx.fillRect(posx, posy + barHeight - d, barWidth, -val.short * barHeight);
                    d += val.short * barHeight;

                    ctx.fillStyle = 'lightgray';
                    ctx.fillRect(posx, posy + barHeight - d, barWidth, d - barHeight);
                    
                    posx += barWidth;
                    if (posx >= width) {
                        posx = 0;
                        posy += 25; // must be bigger than barHeight
                    }
                }
            }


    

        }
    }
}).mount('#app');
