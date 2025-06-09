// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

/**
 * Calculates Adler-32 checksum for binary data.
 * @param {Uint8Array} data - Binary data to checksum
 * @returns {number} 32-bit unsigned checksum
 */
function calculateAdler32(data) {
    let a = 1, b = 0;
    const MOD_ADLER = 65521;

    for (let i = 0; i < data.length; i++) {
        a = (a + data[i]) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }

    return ((b << 16) | a) >>> 0;
}

/**
 * Parses ">blob <base64> <checksum>" line and validates payload.
 * @param {string} blobLine - Line containing ">blob <base64> <checksum>"
 * @returns {Uint8Array} Verified binary payload
 * @throws {Error} On invalid format or checksum mismatch
 */
function parseBlobPayload(blobLine) {
    const parts = blobLine.split(' ');
    if (parts.length < 3 || parts[0] !== ">blob") {
        throw new Error("Invalid blob format");
    }

    const base64Payload = parts[1];
    const expectedChecksum = parts[2];

    // decode base64 payload (URL-safe without padding)
    let binaryData;
    try {
        const standardBase64 = base64Payload.replace(/-/g, '+').replace(/_/g, '/');
        const binaryString = atob(standardBase64);
        binaryData = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            binaryData[i] = binaryString.charCodeAt(i);
        }
    } catch (e) {
        throw new Error("Failed to decode base64: " + e.message);
    }

    // verify checksum
    const actualChecksum = calculateAdler32(binaryData);
    if (actualChecksum.toString(16).padStart(8, '0') !== expectedChecksum) {
        throw new Error("Checksum mismatch");
    }

    return binaryData;
}

/**
 * Parses binary data into EDM poll entries.
 * @param {Uint8Array} binaryData - Raw binary data containing edm_poll_entry_t structs
 * @returns {Array<{short: number, pulse: number, numPulse: number}>} Parsed entries with ratios 0-1
 */
function parseEdmPollEntries(binaryData) {
    const vals = [];
    for (let i = 0; i < binaryData.length; i += 4) {
        if (i + 3 < binaryData.length) {
            const r_short = binaryData[i] / 255.0;
            const r_open = binaryData[i + 1] / 255.0;
            const num_pulse = binaryData[i + 2];
            // skip reserved byte at i+3

            vals.push({
                short: r_short,
                pulse: r_open,
                numPulse: num_pulse
            });
        }
    }

    return vals;
}

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

            // find last blob line
            const lastBlobIx = outputLines.findLastIndex(line => line.startsWith(">blob "));
            if (lastBlobIx < 0) {
                return;
            }

            // parse blob line
            let vals;
            try {
                const binaryData = parseBlobPayload(outputLines[lastBlobIx]);
                vals = parseEdmPollEntries(binaryData);
            } catch (e) {
                console.error("Blob parsing error:", e.message);
                return;
            }

            const edmlData = [{
                state: "blob",
                numPulses: vals.length,
                vals: vals
            }];
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
