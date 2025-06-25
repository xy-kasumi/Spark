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

// Init commands (moved from config.go)
// These were commented out in the original config.go
const initCommands = [
];

Vue.createApp({
    data() {
        return {
            // UI State
            command_text: '',
            client_status: 'unknown',
            log_lines: [],
            exec_status: '',
            xp: 0,
            yp: 0,
            zp: 0,
            
            // Protocol client
            client: null,
        }
    },
    
    computed: {
        commands() {
            return this.command_text.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
        },
        
        log_output() {
            return this.log_lines
                .map(line => `${line.time}${line.dir === 'up' ? '↑' : '↓'}${line.content}`)
                .join('\n');
        },
        
        ui_status() {
            // Map 5 states to 3 UI states
            switch (this.client_status) {
                case 'idle': return 'idle';
                case 'busy': return 'busy';
                case 'api-offline':
                case 'board-offline':
                case 'unknown': return 'offline';
                default: return 'offline';
            }
        },
        
        status_emoji() {
            switch (this.ui_status) {
                case 'idle': return '🔵';
                case 'busy': return '🟠';
                case 'offline': return '⚫';
                default: return '⚫';
            }
        }
    },
    
    mounted() {
        // Initialize client
        this.client = new SpoolerClient(host, 1000);
        
        // Setup callbacks
        this.client.onStatusUpdate = (status) => {
            if (status.x !== undefined) this.xp = status.x;
            if (status.y !== undefined) this.yp = status.y;
            if (status.z !== undefined) this.zp = status.z;
        };
        
        this.client.onStatusChange = (newStatus, oldStatus) => {
            this.client_status = newStatus;
        };
        
        this.client.onLogLine = (line) => {
            this.log_lines.push(line);
            // Keep last 1000 lines
            if (this.log_lines.length > 1000) {
                this.log_lines.shift();
            }
            this.$nextTick(() => {
                if (this.$refs.logOutput) {
                    this.$refs.logOutput.scrollTop = this.$refs.logOutput.scrollHeight;
                }
            });
        };
        
        // Start polling
        this.client.startPolling();
    },
    
    beforeUnmount() {
        if (this.client) {
            this.client.stopPolling();
        }
    },
    
    methods: {
        /**
         * Initialize/home the machine
         */
        async init() {
            this.exec_status = 'Initializing...';
            try {
                if (initCommands.length > 0) {
                    await this.client.sendCommands(initCommands);
                } else {
                    // Send a simple status query if no init commands
                    await this.client.sendCommand('$X');
                }
                this.exec_status = 'Initialized';
            } catch (error) {
                this.exec_status = 'Init Error: ' + error.message;
            }
        },
        
        /**
         * Send user commands
         */
        async send() {
            if (this.commands.length === 0) {
                return;
            }
            
            this.exec_status = 'Executing...';
            try {
                await this.client.sendCommands(this.commands);
                this.exec_status = 'Success';
            } catch (error) {
                this.exec_status = 'Error: ' + error.message;
            }
        },
        
        /**
         * Cancel current operation
         */
        async cancel() {
            try {
                await this.client.sendCancel();
                this.exec_status = 'Cancelled';
            } catch (error) {
                this.exec_status = 'Cancel Error: ' + error.message;
            }
        },
        
        /**
         * Analyze log for blob data and draw EDML visualization
         */
        analyze_log() {
            // Find last blob line in log_lines
            const blobLine = this.log_lines
                .filter(line => line.content.startsWith('>blob '))
                .pop();
                
            if (!blobLine) {
                console.log("No blob data found in log");
                return;
            }
            
            try {
                const binaryData = parseBlobPayload(blobLine.content);
                const vals = parseEdmPollEntries(binaryData);
                this.drawEdml(vals);
            } catch (e) {
                console.error("Blob parsing error:", e.message);
            }
        },
        
        /**
         * Draw EDML visualization on canvas
         * @param {Array} vals - EDM poll entries
         */
        drawEdml(vals) {
            if (!this.$refs.edml) {
                console.error("EDML canvas not found");
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