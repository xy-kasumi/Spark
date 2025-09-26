// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createApp } from 'vue';
import { SpoolerController, spoolerApi } from './spooler.js';

// Chart.js is loaded as global script
declare const Chart: any;

const host = "http://localhost:9000";


const tsJustBeforeInsertZ = 0;
const tsPulledZ = 47;
const tsFullInsertZ = -12;

// Global client instance for performance
let client: SpoolerController | null = null;

const app = createApp({
    data() {
        return {
            // UI State
            commandText: '',
            clientStatus: 'unknown',
            latestPos: {} as Record<string, number>,
            busyStatusText: '',
            jobs: [] as Array<{ job_id: string; status: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'CANCELED'; time_added: Date; time_started?: Date; time_ended?: Date }>,
            clearOnExec: true,
            asJob: false,
            jogStepMm: 1,
            toolSupplyShowDetails: false,
            settingsMachine: {} as Record<string, number>,
            settingsLocal: {} as Record<string, number>,
            settingsFilter: '',
            editingKey: null as string | null,
            escapeHandler: null as ((event: KeyboardEvent) => void) | null,
            tsSpan: 60,
            tsRefreshInterval: 60,
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
                    return 'idle';
                case 'busy':
                    return 'busy';
                case 'api-offline':
                case 'board-offline':
                case 'unknown':
                    return 'offline';
                default:
                    return 'offline';
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

        posLineLocal() {
            if (this.latestPos["sys"] === "machine") {
                return "";
            }

            const prefixTable = {
                "grinder": "g",
                "toolsupply": "t",
                "work": "w",
            };
            const sys = this.latestPos["sys"];
            const prefix = prefixTable[sys];
            if (!prefix) {
                return `(${sys}) unknown`;
            }

            const x = this.latestPos[`${prefix}.x`];
            const y = this.latestPos[`${prefix}.y`];
            const z = this.latestPos[`${prefix}.z`];
            const c = this.latestPos[`${prefix}.c`];
            if (x === undefined || y === undefined || z === undefined || c === undefined) {
                return `(${sys}) unknown`;
            }
            return `(${sys}) X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)} C${c.toFixed(3)}`;
        },

        posLineMachine() {
            const x = this.latestPos["m.x"];
            const y = this.latestPos["m.y"];
            const z = this.latestPos["m.z"];
            const c = this.latestPos["m.c"];
            if (x === undefined || y === undefined || z === undefined || c === undefined) {
                return "(machine) unknown";
            }
            return `(machine) X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)} C${c.toFixed(3)}`;
        },

        initButtonText() {
            return (this.clientStatus === 'idle') ? 'INIT' : 'ENQUEUE INIT';
        },

        executeButtonText() {
            return (this.clientStatus === 'idle') ? 'EXECUTE' : 'ENQUEUE';
        },

        // Display values (local edits take precedence over machine values)
        settings() {
            const result: Record<string, number> = {};

            // Start with machine values
            for (const [key, value] of Object.entries(this.settingsMachine)) {
                result[key] = value as number;
            }

            // Override with local edits
            for (const [key, value] of Object.entries(this.settingsLocal)) {
                result[key] = value as number;
            }

            return result;
        },

        filteredSettings() {
            if (!this.settingsFilter.trim()) {
                return this.settings;
            }

            const filter = this.settingsFilter.toLowerCase();
            const filtered: Record<string, number> = {};

            for (const [key, value] of Object.entries(this.settings)) {
                if (key.toLowerCase().includes(filter)) {
                    filtered[key] = value as number;
                }
            }

            return filtered;
        },

        settingsCount() {
            const total = Object.keys(this.settings).length;
            const filtered = Object.keys(this.filteredSettings).length;
            return { filtered, total };
        },

        modifiedKeys() {
            const modified: string[] = [];
            for (const [key, localValue] of Object.entries(this.settingsLocal)) {
                const machineValue = this.settingsMachine[key];
                if (machineValue !== undefined && localValue !== machineValue) {
                    modified.push(key);
                }
            }
            return modified;
        },

        pendingEditsCount() {
            return this.modifiedKeys.length;
        },

    },

    mounted() {
        // Initialize client
        client = new SpoolerController(host);

        // Setup callbacks
        client.onUpdatePos = (pos) => {
            this.latestPos = pos;
        };
        client.onUpdateStatus = (state, numCommands, runningJob) => {
            this.clientStatus = state;
            if (state === 'busy') {
                if (runningJob !== null) {
                    this.busyStatusText = `Job ${runningJob} running`;
                } else {
                    this.busyStatusText = `${numCommands} commands in queue`;
                }
            }
        };

        // Global Escape key handler to cancel any editing
        this.escapeHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.cancelEdit();
            }
        };
        document.addEventListener('keydown', this.escapeHandler);

        // Initialize empty line chart
        this.chart = new Chart(document.getElementById('timeseries-chart') as HTMLCanvasElement, {
            type: 'line',
            data: { datasets: [] },
            options: { animation: false }
        });

        // Start polling
        client.startPolling();
    },

    beforeUnmount() {
        if (client) {
            client.stopPolling();
        }

        // Clean up global escape handler
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
        }
    },

    methods: {
        /**
         * Initialize/home the machine
         */
        async init() {
            if (!client) {
                return;
            }

            const initData = await spoolerApi.getInit(host);
            for (const cmd of initData.lines) {
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

            if (this.asJob) {
                spoolerApi.addJob(host, this.commands, {
                    "?pos": 1,
                    "?edm": 0.5,
                });
            } else {
                client.enqueueCommands(this.commands); // don't wait
            }

            if (this.clearOnExec) {
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
            return {
                x: this.latestPos["m.x"],
                y: this.latestPos["m.y"],
                z: this.latestPos["m.z"],
            };
        },

        jogHome() {
            client.enqueueCommand("G28");
        },

        /**
         * Jog: X+
         */
        jogXPlus() {
            client.enqueueCommand(`G0 X${(this.currentPos().x + this.jogStepMm).toFixed(3)}`);
            client.requestPosUpdate();
        },

        /**
         * Jog: X-
         */
        jogXMinus() {
            client.enqueueCommand(`G0 X${(this.currentPos().x - this.jogStepMm).toFixed(3)}`);
            client.requestPosUpdate();
        },

        /**
         * Jog: Y+
         */
        jogYPlus() {
            client.enqueueCommand(`G0 Y${(this.currentPos().y + this.jogStepMm).toFixed(3)}`);
            client.requestPosUpdate();
        },

        /**
         * Jog: Y-
         */
        jogYMinus() {
            client.enqueueCommand(`G0 Y${(this.currentPos().y - this.jogStepMm).toFixed(3)}`);
            client.requestPosUpdate();
        },

        /**
         * Jog: Z+
         */
        jogZPlus() {
            client.enqueueCommand(`G0 Z${(this.currentPos().z + this.jogStepMm).toFixed(3)}`);
            client.enqueueCommand('?pos');
        },

        /**
         * Jog: Z-
         */
        jogZMinus() {
            client.enqueueCommand(`G0 Z${(this.currentPos().z - this.jogStepMm).toFixed(3)}`);
            client.enqueueCommand('?pos');
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
            client.enqueueCommands(
                [
                    "G0 C0",
                    "G0 C120",
                    "G0 C240",
                    "G0 C0",
                ]
            );
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
            client.enqueueCommands(
                [
                    "G56",
                    `G0 X0 Y0 Z${tsPulledZ.toFixed(3)}`,
                ]
            );
        },

        tsInsert() {
            const cmds = [];
            cmds.push("G56"); // set again to make this work even if moveToTs was skipped
            cmds.push(`G0 Z${tsJustBeforeInsertZ.toFixed(3)}`);

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
                const x = dx * halfWidth;
                const y = dy * halfWidth;
                const z = tsJustBeforeInsertZ + ofs * dirZ;
                cmds.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);

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
            cmds.push(`G0 X0 Y0 Z${tsFullInsertZ.toFixed(3)}`);

            client.enqueueCommands(cmds);
        },

        tsPull() {
            client.enqueueCommands(
                [
                    `G0 Z${tsPulledZ.toFixed(3)}`,
                    "G53", // back to machine coordinates
                ]
            );
        },

        executeAttach() {
            this.moveToTs();
            this.open();
            this.tsInsert();
            this.clamp();
            this.tsPull();
            this.close();
        },

        executeDetach() {
            this.moveToTs();
            this.tsInsert();
            this.unclamp();
            this.tsPull();
        },

        /**
         * Coordinate System: Machine coordinates
         */
        setMachineCoords() {
            client.enqueueCommand("G53");
            client.requestPosUpdate();
        },

        /**
         * Coordinate System: Work coordinates
         */
        setWorkCoords() {
            client.enqueueCommand("G55");
            client.requestPosUpdate();
        },

        /**
         * Coordinate System: Grinder coordinates
         */
        setGrinderCoords() {
            client.enqueueCommand("G54");
            client.requestPosUpdate();
        },

        /**
         * Coordinate System: Tool supply coordinates
         */
        setToolSupplyCoords() {
            client.enqueueCommand("G56");
            client.requestPosUpdate();
        },

        /**
         * REFRESH button handler for Settings
         */
        async refreshSettings() {
            client.enqueueCommand("get");

            await new Promise(resolve => setTimeout(resolve, 500));

            // TODO: limit to one after "get" somehow
            const res = await spoolerApi.getLatestPState(host, "stg");
            if (res === null) {
                console.error("get didn't result in settings within 500ms");
                return;
            }

            const machineSettings = res.pstate;
            console.log('Machine settings retrieved:', machineSettings);

            // Update machine settings
            this.settingsMachine = machineSettings;

            // If local settings are completely empty (first REFRESH), copy machine values
            if (Object.keys(this.settingsLocal).length === 0) {
                this.settingsLocal = { ...machineSettings };
            } else {
                // Remove local keys that don't exist in machine settings
                const newLocal: Record<string, number> = {};
                for (const [key, value] of Object.entries(this.settingsLocal)) {
                    if (key in machineSettings) {
                        newLocal[key] = value as number;
                    }
                }
                this.settingsLocal = newLocal;
            }
        },

        /**
         * Highlight matching parts of a key based on the current filter
         * @param key - The key to highlight
         * @returns HTML string with highlighted matches
         */
        highlightKey(key: string): string {
            if (!this.settingsFilter.trim()) {
                return key;
            }

            const filter = this.settingsFilter.toLowerCase();
            const keyLower = key.toLowerCase();
            const index = keyLower.indexOf(filter);

            if (index === -1) {
                return key;
            }

            const before = key.substring(0, index);
            const match = key.substring(index, index + filter.length);
            const after = key.substring(index + filter.length);

            return `${before}<span class="highlight">${match}</span>${after}`;
        },

        /**
         * Start editing a setting value
         */
        startEditing(key: string) {
            this.editingKey = key;
        },

        /**
         * Save edited value
         */
        saveEdit(key: string, event: Event) {
            const target = event.target as HTMLInputElement;
            const newValue = parseFloat(target.value);

            if (!isNaN(newValue)) {
                this.settingsLocal[key] = newValue;
            }

            this.editingKey = null;
        },

        /**
         * Cancel editing
         */
        cancelEdit() {
            this.editingKey = null;
        },

        /**
         * Check if a setting is modified
         */
        isModified(key: string): boolean {
            return this.modifiedKeys.includes(key);
        },

        /**
         * Apply all pending edits by sending set commands
         */
        async applyEdits() {
            if (!client || this.pendingEditsCount === 0) {
                return;
            }

            for (const key of this.modifiedKeys) {
                const value = this.settingsLocal[key];
                const command = `set ${key} ${value}`;
                client.enqueueCommand(command);
            }

            // Update machine settings to match local settings for applied changes
            for (const key of this.modifiedKeys) {
                this.settingsMachine[key] = this.settingsLocal[key];
            }

            console.log(`Applied ${this.pendingEditsCount} setting changes`);
        },

        /**
         * Discard all pending edits and revert to machine values
         */
        discardEdits() {
            // Reset local settings to match machine settings
            this.settingsLocal = { ...this.settingsMachine };

            // Cancel any active editing
            this.editingKey = null;

            console.log('Discarded all pending edits');
        },

        /**
         * Save current settings as init commands using setInit API
         */
        async saveAsInit() {
            try {
                const initLines: string[] = [];
                for (const [key, value] of Object.entries(this.settingsLocal)) {
                    initLines.push(`set ${key} ${value}`);
                }

                await spoolerApi.setInit(host, initLines);
                console.log(`Saved ${initLines.length} settings as init commands`);
            } catch (error) {
                console.error('Failed to save settings as init:', error);
            }
        },

        async tsRefreshNow() {
            let visibleKeys = this.chart.getSortedVisibleDatasetMetas().map(meta => meta.label);
            const keys = ["queue.num", "edm.open", "edm.short", "edm.pb_f", "edm.pb_b", "edm.dist", "edm.dist_max"];
            if (visibleKeys.length === 0) {
                // if nothing is visible, show all (can especially happen on first load)
                visibleKeys = keys;
            }
            console.log("visible keys", visibleKeys);

            const nowSec = Math.floor(new Date().getTime() * 1e-3); // floor to suppress annoying sub-sec labels
            const start = new Date((nowSec - this.tsSpan) * 1e3);
            const end = new Date(nowSec * 1e3);

            const targetNumSteps = 100;
            const preAdjustStep = this.tsSpan / targetNumSteps;
            let step;
            // nice-fy step size
            if (preAdjustStep < 0.5) {
                step = 0.5;
            } else if (preAdjustStep < 1) {
                step = 1;
            } else if (preAdjustStep < 5) {
                step = 5;
            } else if (preAdjustStep < 10) {
                step = 10;
            } else if (preAdjustStep < 30) {
                step = 30;
            } else if (preAdjustStep < 60) {
                step = 60;
            } else {
                // minite increments
                step = Math.ceil(preAdjustStep / 60) * 60;
            }

            const includeDate = toLocalDate(start) != toLocalDate(new Date()) || toLocalDate(end) != toLocalDate(new Date());
            const dateToLabel = (d: Date): string => {
                return (includeDate ? toLocalDate(d) + " " : "") + toLocalTime(d);
            };

            const res = await spoolerApi.queryTS(host, start, end, step, keys);
            this.chart.data.labels = res.times.map(dateToLabel);
            this.chart.data.datasets = keys.map(key => ({ label: key, data: res.values[key], hidden: !visibleKeys.includes(key) }));
            console.log(this.chart.data.datasets);
            this.chart.update();
        },

        async refreshJobs() {
            try {
                this.jobs = await spoolerApi.listJobs(host);
            } catch (error) {
                console.error('Failed to refresh jobs:', error);
                this.jobs = [];
            }
        },

        formatJobTime(date: Date): string {
            return date.toLocaleString();
        },

        getElapsedTime(job: { status: string; time_added: Date; time_started?: Date; time_ended?: Date }): string {
            const now = new Date();
            let startTime: Date;
            let endTime: Date;

            if (job.time_started) {
                startTime = job.time_started;
            } else {
                startTime = job.time_added;
            }

            if (job.time_ended) {
                endTime = job.time_ended;
            } else {
                endTime = now;
            }

            const elapsedMs = endTime.getTime() - startTime.getTime();
            const elapsedSec = Math.floor(elapsedMs / 1000);

            const hours = Math.floor(elapsedSec / 3600);
            const minutes = Math.floor((elapsedSec % 3600) / 60);
            const seconds = elapsedSec % 60;

            if (hours > 0) {
                return `${hours}h ${minutes}m ${seconds}s`;
            } else if (minutes > 0) {
                return `${minutes}m ${seconds}s`;
            } else {
                return `${seconds}s`;
            }
        }
    }
});

// Convert Date to "YYYY-MM-DD" string
const toLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// Convert Date to "HH:mm:ss.s" string
function toLocalTime(d = new Date()) {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms[0]}`;
}

// Mount Vue app with error handling
try {
    app.mount('#app');
    console.log('Vue app mounted successfully');
} catch (error) {
    console.error('Vue mounting failed:', error);
    // Remove v-cloak to show raw templates if Vue fails
    document.getElementById('app')?.removeAttribute('v-cloak');
}