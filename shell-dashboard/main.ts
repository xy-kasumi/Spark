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
 * Analyze G1 commands and their execution times
 * @param host - Host to query
 * @returns Array of G1 commands with timing information
 */
async function getRecentG1Commands(host: string): Promise<G1Command[]> {
    try {
        // Find G1 commands
        const g1Result = await spoolerApi.queryLines(host, {
            filter_dir: "down",
            filter_regex: "^G1 "
        });

        if (g1Result.lines.length === 0) {
            console.log("No G1 commands found");
            return [];
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

        console.log("G1 analysis complete:", g1Commands);
        return g1Commands;

    } catch (e) {
        console.error("G1 analysis error:", e.message);
        return [];
    }
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
    "set ts.servo.closems 1.75",
    "set ts.servo.openms 0.85",
    "set m.0.idlems -1",
    "set m.1.idlems -1",
    "set m.2.idlems -1",
    "set m.1.thresh 1",
    "set m.6.unitsteps -814.87",
    "set cs.g.pos.x -58",
    "set cs.g.pos.y 76",
    "set cs.g.pos.z -73",
    "set cs.w.pos.x -58",
    "set cs.w.pos.y 17",
    "set cs.w.pos.z -89",
];

const tsCenterX = -14.5;
const tsCenterY = 103.5;
const tsPulledZ = -10;
const tsJustBeforeInsertZ = -57;
const tsFullInsertZ = -68;

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
            jogStepMm: 1,
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
         * Parse current position from statusText
         */
        currentPos(): { x: number, y: number, z: number } {
            if (!this.statusText) {
                return { x: 0, y: 0, z: 0 };
            }

            // Extract first occurrence of X, Y, Z values
            const xMatch = this.statusText.match(/X(-?\d+(?:\.\d+)?)/);
            const yMatch = this.statusText.match(/Y(-?\d+(?:\.\d+)?)/);
            const zMatch = this.statusText.match(/Z(-?\d+(?:\.\d+)?)/);

            const x = xMatch ? parseFloat(xMatch[1]) : 0;
            const y = yMatch ? parseFloat(yMatch[1]) : 0;
            const z = zMatch ? parseFloat(zMatch[1]) : 0;

            return { x, y, z };
        },

        /**
         * Analyze log for blob data and draw EDML visualization
         */
        async analyzeLog() {
            this.g1Commands = await getRecentG1Commands(host);

            try {
                const blobData = await spoolerApi.getLastUpBlob(host);
                if (blobData) {
                    const vals = parseEdmPollEntries(blobData);
                    this.drawEdml(vals);
                }
            } catch (e) {
                console.error("Blob analysis error:", e.message);
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
        },

        /**
         * Jog: X+
         */
        jogXPlus() {
            client.enqueueCommand(`G0 X${(this.currentPos().x + this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Jog: X-
         */
        jogXMinus() {
            client.enqueueCommand(`G0 X${(this.currentPos().x - this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Jog: Y+
         */
        jogYPlus() {
            client.enqueueCommand(`G0 Y${(this.currentPos().y + this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Jog: Y-
         */
        jogYMinus() {
            client.enqueueCommand(`G0 Y${(this.currentPos().y - this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Jog: Z+
         */
        jogZPlus() {
            client.enqueueCommand(`G0 Z${(this.currentPos().z + this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Jog: Z-
         */
        jogZMinus() {
            client.enqueueCommand(`G0 Z${(this.currentPos().z - this.jogStepMm).toFixed(3)}`);
        },

        /**
         * Tool supply: Clamp
         */
        clamp() {
            [
                "G0 C0",
                "G0 C240",
                "G0 C120",
                "G0 C0",
                "G0 C240",
                "G0 C120",
                "G0 C0",
            ].forEach(cmd => client.enqueueCommand(cmd));
        },

        /**
         * Tool supply: Unclamp
         */
        unclamp() {
            [
                "G0 C0",
                "G0 C120",
                "G0 C240",
                "G0 C0",
            ].forEach(cmd => client.enqueueCommand(cmd));
        },

        /**
         * Tool supply: Open
         */
        open() {
            client.enqueueCommand("M60");
        },

        /**
         * Tool supply: Close
         */
        close() {
            client.enqueueCommand("M61");
        },

        moveToTs() {
            client.enqueueCommand(`G0 X${tsCenterX.toFixed(3)} Y${tsCenterY.toFixed(3)}`);
        },

        tsInsert() {
            client.enqueueCommand(`G0 Z${tsJustBeforeInsertZ.toFixed(3)}`);

            // Insert using square-helix path to align tool to the chuck.
            const halfWidth = 0.25;
            const quarterPitch = 0.1;
            const durZ = Math.abs(tsFullInsertZ - tsJustBeforeInsertZ);
            const dirZ = Math.sign(tsFullInsertZ - tsJustBeforeInsertZ);

            let ofs = 0;
            let phase = 0;
            let offsets = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
            while (true) {
                const [dx, dy] = offsets[phase];
                const x = tsCenterX + dx * halfWidth;
                const y = tsCenterY + dy * halfWidth;
                const z = tsJustBeforeInsertZ + ofs * dirZ;
                client.enqueueCommand(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);

                const nextOfs = ofs + quarterPitch;
                if (nextOfs >= durZ) {
                    // spiral ended
                    break;
                } else {
                    // continue
                    phase = (phase + 1) % 4;
                    ofs += quarterPitch;
                }
            }

            // return to center for final point.
            client.enqueueCommand(`G0 X${tsCenterX.toFixed(3)} Y${tsCenterY.toFixed(3)} Z${tsFullInsertZ.toFixed(3)}`);
        },

        tsPull() {
            client.enqueueCommand(`G0 Z${tsPulledZ.toFixed(3)}`);
        }
    }
}).mount('#app');