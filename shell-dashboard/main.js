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
        }
    }
}).mount('#app');
