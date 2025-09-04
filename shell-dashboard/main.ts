// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

const host = "http://localhost:9000";

interface EdmPollEntry {
    short: number;
    open: number;
    pulse: number;
}

interface G1Command {
    startTime: string;
    startLineNum: number;
    command: string;
    duration?: number;
    endTime?: string;
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
            const r_pulse = 1 - (r_short + r_open);
            // skip reserved byte at i+2, i+3

            vals.push({
                short: r_short,
                open: r_open,
                pulse: r_pulse,
            });
        }
    }

    return vals;
}

// Init commands (moved from config.go)
// These were commented out in the original config.go
const initCommands: string[] = [
    "set m.6.unitsteps -814.87",
    "set cs.g.pos.x -58",
    "set cs.g.pos.y 76",
    "set cs.g.pos.z -73",
    "set cs.w.pos.x -58",
    "set cs.w.pos.y 17",
    "set cs.w.pos.z -89",
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
            rebootTime: null as string | null,
            assumeInitialized: true, // true if we think init commands were executed or enqueued
            g1Commands: [] as G1Command[],
            keepOnExec: false,
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
        
        rebootStatus() {
            if (!this.rebootTime) {
                return '';
            }
            if (!this.assumeInitialized) {
                return `rebooted at ${this.rebootTime} (not initialized)`;
            } else {
                return `rebooted at ${this.rebootTime}`;
            }
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
        
        client.onReboot = () => {
            this.rebootTime = new Date().toLocaleTimeString();
            this.assumeInitialized = false;
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
            
            // Assume machine will be initialized after init commands
            this.assumeInitialized = true;
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
            
            if (!this.keepOnExec) {
            this.commandText = '';
            }
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
        async analyzeLog() {
            try {
                // Analyze G1 commands
                await this.analyzeG1Commands();
                
                // Analyze blob data
                const blobData = await spoolerApi.getLastUpBlob(host);
                
                if (!blobData) {
                    console.log("No blob data found in log");
                    return;
                }
                
                const vals = parseEdmPollEntries(blobData);
                this.drawEdml(vals);
            } catch (e) {
                console.error("Blob analysis error:", e.message);
            }
        },
        
        /**
         * Analyze G1 commands and their execution times
         */
        async analyzeG1Commands() {
            try {
                // Find G1 commands
                const g1Result = await spoolerApi.queryLines(host, {
                    filter_dir: "down",
                    filter_regex: "^G1 "
                });
                
                if (g1Result.lines.length === 0) {
                    console.log("No G1 commands found");
                    this.g1Commands = [];
                    return;
                }
                console.log(g1Result);
                
                const g1Commands: G1Command[] = [];
                
                // Step 2: For each G1 command, find its completion
                for (const g1Line of g1Result.lines) {
                    const g1Command: G1Command = {
                        startTime: g1Line.time,
                        startLineNum: g1Line.line_num,
                        command: g1Line.content
                    };
                    
                    // Query for the first "I" line after this G1
                    const completionResult = await spoolerApi.queryLines(host, {
                        from_line: g1Line.line_num + 1,
                        filter_dir: "up",
                        filter_regex: "^I",
                    });
                    
                    if (completionResult.lines.length > 0) {
                        const endLine = completionResult.lines[0];
                        g1Command.endTime = endLine.time;
                        
                        // Calculate duration in seconds
                        const startMs = new Date(g1Line.time).getTime();
                        const endMs = new Date(endLine.time).getTime();
                        g1Command.duration = Math.round((endMs - startMs) / 1000);
                    } else {
                        // Still executing - calculate duration from start to now
                        const startMs = new Date(g1Line.time).getTime();
                        const nowMs = Date.now();
                        g1Command.duration = Math.round((nowMs - startMs) / 1000);
                    }
                    
                    g1Commands.push(g1Command);
                }
                
                // Sort by start time (newest first)
                g1Commands.sort((a, b) => 
                    new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
                );
                
                this.g1Commands = g1Commands;
                console.log("G1 analysis complete:", g1Commands);
                
            } catch (e) {
                console.error("G1 analysis error:", e.message);
                this.g1Commands = [];
            }
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
                    ctx.fillStyle = '#00aeef'; // blue = pulse
                    ctx.fillRect(posx, posy + barHeight, barWidth, -val.pulse * barHeight);
                    d += val.pulse * barHeight;

                    ctx.fillStyle = '#F03266'; // red = short
                    ctx.fillRect(posx, posy + barHeight - d, barWidth, -val.short * barHeight);
                    d += val.short * barHeight;

                    ctx.fillStyle = 'lightgray'; // gray = open
                    ctx.fillRect(posx, posy + barHeight - d, barWidth, -val.open * barHeight);

                    // (white = no activity)

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