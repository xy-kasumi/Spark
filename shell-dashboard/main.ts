// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

interface EdmPollEntry {
    short: number;
    pulse: number;
    numPulse: number;
}

/**
 * Parses binary data into EDM poll entries.
 * @param binaryData - Raw binary data containing edm_poll_entry_t structs
 * @returns Parsed entries with ratios 0-1
 */
function parseEdmPollEntries(binaryData: Uint8Array): EdmPollEntry[] {
    const vals: EdmPollEntry[] = [];
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
const initCommands: string[] = [
];

// Global client instance for performance
let client: SpoolerController | null = null;

Vue.createApp({
    data() {
        return {
            // UI State
            commandText: '',
            clientStatus: 'unknown',
            statusText: '',
            commandQueue: [],
        }
    },
    
    computed: {
        commands() {
            return this.commandText.split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);
        },
        
        uiStatus() {
            // Map 6 states to 3 UI states
            switch (this.clientStatus) {
                case 'idle':
                case 'busy-healthcheck': return 'idle';
                case 'busy': return 'busy';
                case 'api-offline':
                case 'board-offline':
                case 'unknown': return 'offline';
                default: return 'offline';
            }
        },
        
        statusEmoji() {
            switch (this.uiStatus) {
                case 'idle': return '🔵';
                case 'busy': return '🟠';
                case 'offline': return '⚫';
                default: return '⚫';
            }
        },
        
        initButtonText() {
            return (this.clientStatus === 'idle' || this.clientStatus === 'busy-healthcheck') ? 'Init' : 'Enqueue Init';
        },
        
        executeButtonText() {
            return (this.clientStatus === 'idle' || this.clientStatus === 'busy-healthcheck') ? 'Execute' : 'Enqueue';
        },
        
        queueStatus() {
            const queueLength = this.commandQueue.length;
            if (queueLength === 0) {
                return '';
            }
            
            return `${queueLength} commands in queue`;
        },
        
    },
    
    mounted() {
        // Initialize client
        client = new SpoolerController(host, 1000);
        
        // Setup callbacks
        client.onUpdate = (state, status) => {
            this.clientStatus = state;
            this.statusText = status;
        };
        
        client.onQueueChange = () => {
            this.commandQueue = client.peekQueue();
        };
        
        // Start polling
        client.startPolling();
    },
    
    beforeUnmount() {
        if (client) {
            client.stopPolling();
        }
    },
    
    methods: {
        /**
         * Initialize/home the machine
         */
        init() {
            if (!client) {
                return;
            }
            
            for (const cmd of initCommands) {
                client.enqueueCommand(cmd);
            }
        },
        
        /**
         * Send user commands
         */
        send() {
            if (!client || this.commands.length === 0) {
                return;
            }
            
            for (const cmd of this.commands) {
                client.enqueueCommand(cmd);
            }
            this.commandText = '';
        },
        
        /**
         * Cancel current operation
         */
        cancel() {
            if (!client) return;
            client.cancel();
        },
        
        /**
         * Analyze log for blob data and draw EDML visualization
         */
        analyzeLog() {
            // TODO: Fix data source - log_lines was removed with Serial Log feature
            console.log("analyze_log called but data source not available");
            return;
            
            // Original implementation for reference:
            // const blobLine = this.log_lines
            //     .filter(line => line.content.startsWith('>blob '))
            //     .pop();
            //     
            // if (!blobLine) {
            //     console.log("No blob data found in log");
            //     return;
            // }
            // 
            // try {
            //     const binaryData = parseBlobPayload(blobLine.content);
            //     const vals = parseEdmPollEntries(binaryData);
            //     this.drawEdml(vals);
            // } catch (e) {
            //     console.error("Blob parsing error:", e.message);
            // }
        },
        
        /**
         * Draw EDML visualization on canvas
         * @param vals - EDM poll entries
         */
        drawEdml(vals: EdmPollEntry[]): void {
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