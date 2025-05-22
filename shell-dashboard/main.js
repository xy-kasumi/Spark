// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

Vue.createApp({
    data() {
        return {
            data: '',
            spooler_status: 'Unknown',
            core_status: 'Unknown',
            log_output: '',
            xp: 0,
            yp: 0,
            zp: 0,
        }
    },
    methods: {
        async move_xm() {
            try {
                const res = await fetch(host + '/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: "$J=G91 X-5 F100\n" })
                });
                const text = await res.text();
                if (!res.ok) throw new Error(text);
                this.status = 'Success: ' + text;
            } catch (err) {
                this.status = 'Error: ' + err.message;
            }
        },
        async move_xp() {
            try {
                const res = await fetch(host + '/write', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: "$J=G91 X5 F100\n" })
                });
                const text = await res.text();
                if (!res.ok) throw new Error(text);
                this.status = 'Success: ' + text;
            } catch (err) {
                this.status = 'Error: ' + err.message;
            }
        },
        async home() {
            try {
                const res = await fetch(host + '/home', {
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
        },
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
            await this.refresh();
        }
    }
}).mount('#app');
