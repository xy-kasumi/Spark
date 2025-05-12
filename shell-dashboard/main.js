// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

Vue.createApp({
    data() {
        return {
            data: '',
            status: '',
            spooler_status: 'Unknown',
            log_output: '',
        }
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
                if (respJson.status !== "ok") {
                    this.spooler_status = 'Connected (Error)';
                    return;
                }
                this.spooler_status = 'Connected (OK)';
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
        },
        async send() {
            this.status = 'Sending...';
            try {
                const res = await fetch(host + '/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: this.data })
                });
                const text = await res.text();
                if (!res.ok) throw new Error(text);
                this.status = 'Success: ' + text;
            } catch (err) {
                this.status = 'Error: ' + err.message;
            }
        }
    }
}).mount('#app');
