<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div v-cloak>
    <!-- Fixed Header with Status -->
    <header class="fixed-header">
      <div class="header-content">
        <img :src="logoUrl" alt="Spark Logo" class="header-logo">
        <div class="status-info">
          <span :title="'Detailed status: ' + clientStatus">{{ statusEmoji }} {{ uiStatus }}</span>
          {{ busyStatusText }}
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <div class="main-content">
      <div class="column">

        <div class="widget">
          <h1>Manual Command</h1>
          <div class="widget-content">
            <button class="" @click="init">{{ initButtonText }}</button>
            <br />
            <textarea class="" v-model="commandText" rows="10" cols="50"
              placeholder="Enter G-code or commands"></textarea><br />
            <button class="" @click="send" :disabled="commands.length === 0 || !assumeInitialized">{{
              executeButtonText }}</button>
            <button class="" @click="cancel">CANCEL</button>
            <label class="">
              <input type="checkbox" v-model="clearOnExec"> Clear on exec
            </label>
            <label class="">
              <input type="checkbox" v-model="asJob"> As Job
            </label>
          </div>
        </div>

        <div class="widget">
          <h1>Coordinate System</h1>
          <div class="widget-content">
            <button @click="setMachineCoords">MACHINE</button>
            <button @click="setWorkCoords">WORK</button>
            <button @click="setGrinderCoords">GRINDER</button>
            <button @click="setToolSupplyCoords">TOOLSUPPLY</button>
          </div>
        </div>

        <div class="widget" id="widget-jog">
          <h1>Jog</h1>
          <div class="widget-content">
            <div>{{ posLineLocal }}</div>
            <div>{{ posLineMachine }}</div>
            <br />
            <table class="jog-table">
              <tr>
                <td></td>
                <td><button class="jog-btn" @click="jogXPlus">X+</button></td>
                <td></td>
                <td></td>
                <td><button class="jog-btn" @click="jogZMinus">↑ Z-</button></td>
              </tr>
              <tr>
                <td><button class="jog-btn" @click="jogYPlus">Y+</button></td>
                <td></td>
                <td><button class="jog-btn" @click="jogYMinus">Y-</button></td>
                <td><button class="jog-btn" @click="jogHome">HOME</button></td>
                <td><button class="jog-btn" @click="jogZPlus">↓ Z+</button></td>
              </tr>
              <tr>
                <td></td>
                <td><button class="jog-btn" @click="jogXMinus">X-</button></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
            </table>

            <div>
              <label class="">
                <input type="radio" name="jogStep" :value="0.1" v-model.number="jogStepMm"> 0.1mm
              </label>
              <label class="">
                <input type="radio" name="jogStep" :value="1" v-model.number="jogStepMm"> 1mm
              </label>
              <label class="">
                <input type="radio" name="jogStep" :value="5" v-model.number="jogStepMm"> 5mm
              </label>
            </div>
          </div>
        </div>

        <div class="widget">
          <h1>Tool Supply</h1>
          <div class="widget-content">
            <div style="margin-bottom: var(--unit-space)">
              <label class="">
                <input type="checkbox" v-model="toolSupplyShowDetails"> Individual actions
              </label>
            </div>

            <div v-if="!toolSupplyShowDetails">
              <button class="" @click="executeAttach">ATTACH</button>
              <button class="" @click="executeDetach">DETACH</button>
            </div>

            <div v-if="toolSupplyShowDetails">
              <div style="margin-bottom: var(--unit-space)">
                ATTACH
                <br />
                <div>
                  <button class="" @click="moveToTs">MOVE</button>
                  <button class="" @click="open">OPEN</button>
                  <button class="" @click="tsInsert">INSERT</button>
                  <button class="" @click="clamp">CLAMP</button>
                  <button class="" @click="tsPull">PULL</button>
                  <button class="" @click="close">CLOSE</button>
                </div>
              </div>
              <div style="margin-bottom: var(--unit-space)">
                DETACH
                <br />
                <div>
                  <button class="" @click="moveToTs">MOVE</button>
                  <button class="" @click="tsInsert">INSERT</button>
                  <button class="" @click="unclamp">UNCLAMP</button>
                  <button class="" @click="tsPull">PULL</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="widget" id="widget-joblist">
          <h1>Job List</h1>
          <div class="widget-content">
            <button @click="refreshJobs">REFRESH</button>
            <div v-if="jobs.length === 0">
              No jobs found
            </div>
            <table v-else style="width: 100%; border-collapse: collapse; margin-top: var(--unit-space);">
              <thead>
                <tr>
                  <th
                    style="text-align: left; padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    Status</th>
                  <th
                    style="text-align: left; padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    Started</th>
                  <th
                    style="text-align: left; padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    Elapsed</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="job in jobs" :key="job.job_id">
                  <td
                    style="padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    {{ job.status }}</td>
                  <td
                    style="padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    {{ formatJobTime(job.time_added) }}</td>
                  <td
                    style="padding: calc(var(--unit-space) * 0.5); border-bottom: 1px solid var(--border-color);">
                    {{ getElapsedTime(job) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="column">
        <div class="widget" id="widget-settings">
          <h1>Settings</h1>
          <div class="widget-content">
            <button @click="refreshSettings">REFRESH</button>
            <br />
            <div v-if="Object.keys(settings).length === 0" class="settings-placeholder">
              Click REFRESH to load settings
            </div>
            <div v-else>
              <label>Filter <input type="text" v-model="settingsFilter"
                  placeholder="Enter filter..."></label>
              <div class="settings-info">Showing {{ settingsCount.filtered }}/{{ settingsCount.total }}
                items</div>
              <div class="settings-table-container">
                <table class="settings-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(value, key) in filteredSettings" :key="key">
                      <td v-html="highlightKey(key)"></td>
                      <td v-if="editingKey !== key" @click="startEditing(key)"
                        style="cursor: pointer;">
                        {{ value }}
                        <span v-if="isModified(key)"
                          class="modified-indicator">(modified)</span>
                      </td>
                      <td v-else>
                        <input type="number" :value="value" @blur="saveEdit(key, $event)"
                          @keyup.enter="saveEdit(key, $event)" ref="editInput">
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="pendingEditsCount > 0" style="margin-top: var(--unit-space);">
                <button @click="applyEdits">APPLY EDITS</button>
                <button @click="discardEdits">DISCARD EDITS</button>
              </div>
              <div v-if="pendingEditsCount === 0" style="margin-top: var(--unit-space);">
                <button @click="saveAsInit">SAVE AS INIT</button>
              </div>
            </div>
          </div>
        </div>

        <div class="widget" id="widget-timeseries">
          <h1>Timeseries</h1>
          <div class="widget-content">
            <div>
              Last
              <label class="">
                <input type="radio" name="tsSpan" :value="60" v-model.number="tsSpan"> 1m
              </label>
              <label class="">
                <input type="radio" name="tsSpan" :value="600" v-model.number="tsSpan"> 10m
              </label>
              <label class="">
                <input type="radio" name="tsSpan" :value="3600" v-model.number="tsSpan"> 60m
              </label>
            </div>
            <div>
              Auto refresh
              <label class="">
                <input type="radio" name="tsRefreshInterval" :value="0"
                  v-model.number="tsRefreshInterval"> No
              </label>
              <label class="">
                <input type="radio" name="tsRefreshInterval" :value="10"
                  v-model.number="tsRefreshInterval"> 10s
              </label>
              <label class="">
                <input type="radio" name="tsRefreshInterval" :value="60"
                  v-model.number="tsRefreshInterval"> 1m
              </label>
              <button @click="tsRefreshNow">REFRESH</button>
            </div>
            <canvas id="timeseries-chart" width="500" height="300"></canvas>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script>
import { SpoolerController, spoolerApi } from './spooler.ts';
import { Chart, registerables } from 'chart.js';
import logoUrl from './logo.png';

// Register Chart.js components
Chart.register(...registerables);

const host = "http://localhost:9000";

const tsJustBeforeInsertZ = 0;
const tsPulledZ = 47;
const tsFullInsertZ = -12;

// Global client instance for performance
let client = null;
let chart = null;

// Convert Date to "YYYY-MM-DD" string
const toLocalDate = (d) => {
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

export default {
    data() {
        return {
            // UI State
            logoUrl,
            commandText: '',
            clientStatus: 'unknown',
            latestPos: {},
            busyStatusText: '',
            jobs: [],
            clearOnExec: true,
            asJob: false,
            jogStepMm: 1,
            toolSupplyShowDetails: false,
            settingsMachine: {},
            settingsLocal: {},
            settingsFilter: '',
            editingKey: null,
            escapeHandler: null,
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

        assumeInitialized() {
            return this.clientStatus === 'idle' || this.clientStatus === 'busy';
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
            const result = {};

            // Start with machine values
            for (const [key, value] of Object.entries(this.settingsMachine)) {
                result[key] = value;
            }

            // Override with local edits
            for (const [key, value] of Object.entries(this.settingsLocal)) {
                result[key] = value;
            }

            return result;
        },

        filteredSettings() {
            if (!this.settingsFilter.trim()) {
                return this.settings;
            }

            const filter = this.settingsFilter.toLowerCase();
            const filtered = {};

            for (const [key, value] of Object.entries(this.settings)) {
                if (key.toLowerCase().includes(filter)) {
                    filtered[key] = value;
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
            const modified = [];
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
        this.escapeHandler = (event) => {
            if (event.key === 'Escape') {
                this.cancelEdit();
            }
        };
        document.addEventListener('keydown', this.escapeHandler);

        // Initialize empty line chart
        chart = new Chart(document.getElementById('timeseries-chart'), {
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
        currentPos() {
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
                const newLocal = {};
                for (const [key, value] of Object.entries(this.settingsLocal)) {
                    if (key in machineSettings) {
                        newLocal[key] = value;
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
        highlightKey(key) {
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
        startEditing(key) {
            this.editingKey = key;
        },

        /**
         * Save edited value
         */
        saveEdit(key, event) {
            const target = event.target;
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
        isModified(key) {
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
                const initLines = [];
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
            let visibleKeys = chart.getSortedVisibleDatasetMetas().map(meta => meta.label);
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
            const dateToLabel = (d) => {
                return (includeDate ? toLocalDate(d) + " " : "") + toLocalTime(d);
            };

            const res = await spoolerApi.queryTS(host, start, end, step, keys);
            chart.data.labels = res.times.map(dateToLabel);
            chart.data.datasets = keys.map(key => ({ label: key, data: res.values[key], hidden: !visibleKeys.includes(key) }));
            console.log(chart.data.datasets);
            chart.update();
        },

        async refreshJobs() {
            try {
                this.jobs = await spoolerApi.listJobs(host);
            } catch (error) {
                console.error('Failed to refresh jobs:', error);
                this.jobs = [];
            }
        },

        formatJobTime(date) {
            return date.toLocaleString();
        },

        getElapsedTime(job) {
            const now = new Date();
            let startTime;
            let endTime;

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
}
</script>

<style>
/* Design tokens */
:root {
  --unit-space: 8px;
  --text-size: 16px;
  --radius: 4px;
  --accent: #00aeef;

  --bg-primary: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-widget: #252525;
  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --border-color: #404040;
  --shadow-color: rgba(0, 0, 0, 0.3);
  --button-bg: #404040;
  --button-hover: #4a4a4a;
}

/* Global page layout (header & columns) & widgets */
body {
  background-color: var(--bg-primary);
  color: var(--text-primary);
  font-family: Arial, sans-serif;
  font-size: var(--text-size);
  margin: 0;
}

.fixed-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  padding: 10px 20px;
  z-index: 1000;
  box-shadow: 0 2px 4px var(--shadow-color);
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 20px;
}

.main-content {
  display: flex;
  gap: calc(var(--unit-space) * 2);
  /* two widget width + gap */
  width: calc(var(--unit-space) * (70 * 2 + 2));

  margin: 0 auto;

  /* overlap with header */
  padding-top: 88px;
}

.column {
  width: calc(var(--unit-space) * 70);
}

.widget {
  width: calc(var(--unit-space) * 70);
  background: var(--bg-widget);
  border: 1px solid var(--border-color);
  box-shadow: 0 2px 4px var(--shadow-color);
  margin-bottom: calc(var(--unit-space) * 2);
}

.widget>h1 {
  font-size: var(--text-size);
  font-weight: bold;
  margin: 0;
  border-bottom: 1px solid var(--accent);
  color: var(--text-primary);
  padding: var(--unit-space);
  background: var(--bg-secondary);
}

.widget>.widget-content {
  padding: var(--unit-space);
}

/* Components */
button {
  background: var(--button-bg);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  padding: var(--unit-space);
  height: calc(var(--unit-space) * 4);

  font-size: calc(var(--text-size) * 0.8);
  /* since button texts are all-caps, make it smaller to balance with bold titles */
  font-weight: bold;
  line-height: 1;

  border-radius: var(--radius);
  cursor: pointer;

  margin-right: var(--unit-space);
  margin-bottom: var(--unit-space);
}

button:hover {
  background: var(--button-hover);
}

button:disabled {
  background: #2a2a2a;
  color: #666;
  cursor: not-allowed;
}

textarea,
input[type="text"],
input[type="number"],
input[type="checkbox"] {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  padding: var(--unit-space);
  border-radius: var(--radius);
  margin-bottom: var(--unit-space);
}

textarea {
  line-height: 1.4;
}

textarea:focus,
input:focus {
  border-color: #555;
  outline: none;
}

label {
  color: var(--text-primary);
  margin-right: 15px;
}


/* Part-specific things */
.fixed-header .header-logo {
  height: 40px;
  width: auto;
}

.fixed-header .status-info {
  display: flex;
  align-items: center;
  gap: 15px;
  font-size: 16px;
}


#widget-jog .jog-table {
  border-spacing: calc(var(--unit-space) * 0.5);
  margin-bottom: var(--unit-space);
}

#widget-jog .jog-table td {
  width: calc(var(--unit-space) * 6);
  height: calc(var(--unit-space) * 6);
  text-align: center;
  vertical-align: middle;
  padding: 0;
}

#widget-jog .jog-btn {
  width: calc(var(--unit-space) * 6);
  height: calc(var(--unit-space) * 6);
  padding: 0;
  margin: 0;
}

#widget-settings .settings-placeholder {
  color: var(--text-secondary);
  font-style: italic;
  margin-top: var(--unit-space);
}

#widget-settings .settings-table-container {
  max-height: 300px;
  overflow-y: auto;
  margin-top: var(--unit-space);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

#widget-settings .settings-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-secondary);
}

#widget-settings .settings-table th,
#widget-settings .settings-table td {
  padding: calc(var(--unit-space) * 0.75);
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

#widget-settings .settings-table th {
  background: var(--bg-widget);
  color: var(--text-primary);
  font-weight: bold;
  position: sticky;
  top: 0;
  z-index: 1;
}

#widget-settings .settings-table td {
  color: var(--text-primary);
}

#widget-settings .settings-table tbody tr:hover {
  background: var(--button-bg);
}

#widget-settings .settings-info {
  color: var(--text-secondary);
  font-size: calc(var(--text-size) * 0.9);
  margin-bottom: calc(var(--unit-space) * 0.5);
}

#widget-settings .highlight {
  background-color: var(--accent);
  color: white;
  padding: 1px 2px;
  border-radius: 2px;
  font-weight: bold;
}

#widget-settings .modified-indicator {
  color: var(--accent);
  font-style: italic;
  font-size: calc(var(--text-size) * 0.85);
  margin-left: 5px;
}

#widget-settings .settings-table td input {
  width: 100%;
  height: calc(var(--unit-space) * 0.75 * 2 + var(--text-size) * 1.2);
  box-sizing: border-box;
  margin: 0;
  padding: calc(var(--unit-space) * 0.75);
  background: var(--bg-primary);
  color: var(--text-primary);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
}

/* Hide Vue templates until Vue loads */
[v-cloak] {
  display: none !important;
}
</style>