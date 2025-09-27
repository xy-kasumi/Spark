<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Settings</h1>
    <div class="widget-content">
      <button @click="refreshSettings">REFRESH</button>
      <br />
      <div
        v-if="Object.keys(settings).length === 0"
        class="settings-placeholder"
      >
        Click REFRESH to load settings
      </div>
      <div v-else>
        <label
          >Filter
          <input
            type="text"
            v-model="settingsFilter"
            placeholder="Enter filter..."
        /></label>
        <div class="settings-info">
          Showing {{ settingsCount.filtered }}/{{ settingsCount.total }} items
        </div>
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
                <td
                  v-if="editingKey !== key"
                  @click="startEditing(key)"
                  style="cursor: pointer"
                >
                  {{ value }}
                  <span v-if="isModified(key)" class="modified-indicator"
                    >(modified)</span
                  >
                </td>
                <td v-else>
                  <input
                    type="number"
                    :value="value"
                    @blur="saveEdit(key, $event)"
                    @keyup.enter="saveEdit(key, $event)"
                    ref="editInput"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="pendingEditsCount > 0" style="margin-top: var(--unit-space)">
          <button @click="applyEdits">APPLY EDITS</button>
          <button @click="discardEdits">DISCARD EDITS</button>
        </div>
        <div
          v-if="pendingEditsCount === 0"
          style="margin-top: var(--unit-space)"
        >
          <button @click="saveAsInit">SAVE AS INIT</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { spoolerApi } from "../spooler.ts";

export default {
  name: "Settings",
  props: {
    client: Object,
  },
  data() {
    return {
      settingsMachine: {},
      settingsLocal: {},
      settingsFilter: "",
      editingKey: null,
      escapeHandler: null,
    };
  },
  computed: {
    settings() {
      const result = {};

      for (const [key, value] of Object.entries(this.settingsMachine)) {
        result[key] = value;
      }

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
    this.escapeHandler = (event) => {
      if (event.key === "Escape") {
        this.cancelEdit();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);
  },
  beforeUnmount() {
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
    }
  },
  methods: {
    async refreshSettings() {
      this.client.enqueueCommand("get");

      await new Promise((resolve) => setTimeout(resolve, 500));

      const host = "http://localhost:9000";
      const res = await spoolerApi.getLatestPState(host, "stg");
      if (res === null) {
        console.error("get didn't result in settings within 500ms");
        return;
      }

      const machineSettings = res.pstate;
      console.log("Machine settings retrieved:", machineSettings);

      this.settingsMachine = machineSettings;

      if (Object.keys(this.settingsLocal).length === 0) {
        this.settingsLocal = { ...machineSettings };
      } else {
        const newLocal = {};
        for (const [key, value] of Object.entries(this.settingsLocal)) {
          if (key in machineSettings) {
            newLocal[key] = value;
          }
        }
        this.settingsLocal = newLocal;
      }
    },

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

    startEditing(key) {
      this.editingKey = key;
    },

    saveEdit(key, event) {
      const target = event.target;
      const newValue = parseFloat(target.value);

      if (!isNaN(newValue)) {
        this.settingsLocal[key] = newValue;
      }

      this.editingKey = null;
    },

    cancelEdit() {
      this.editingKey = null;
    },

    isModified(key) {
      return this.modifiedKeys.includes(key);
    },

    async applyEdits() {
      if (!this.client || this.pendingEditsCount === 0) {
        return;
      }

      for (const key of this.modifiedKeys) {
        const value = this.settingsLocal[key];
        const command = `set ${key} ${value}`;
        this.client.enqueueCommand(command);
      }

      for (const key of this.modifiedKeys) {
        this.settingsMachine[key] = this.settingsLocal[key];
      }

      console.log(`Applied ${this.pendingEditsCount} setting changes`);
    },

    discardEdits() {
      this.settingsLocal = { ...this.settingsMachine };
      this.editingKey = null;
      console.log("Discarded all pending edits");
    },

    async saveAsInit() {
      try {
        const initLines = [];
        for (const [key, value] of Object.entries(this.settingsLocal)) {
          initLines.push(`set ${key} ${value}`);
        }

        const host = "http://localhost:9000";
        await spoolerApi.setInit(host, initLines);
        console.log(`Saved ${initLines.length} settings as init commands`);
      } catch (error) {
        console.error("Failed to save settings as init:", error);
      }
    },
  },
};
</script>

<style scoped>
.settings-placeholder {
  color: var(--text-secondary);
  font-style: italic;
  margin-top: var(--unit-space);
}

.settings-table-container {
  max-height: 300px;
  overflow-y: auto;
  margin-top: var(--unit-space);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.settings-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-secondary);
}

.settings-table th,
.settings-table td {
  padding: calc(var(--unit-space) * 0.75);
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.settings-table th {
  background: var(--bg-widget);
  color: var(--text-primary);
  font-weight: bold;
  position: sticky;
  top: 0;
  z-index: 1;
}

.settings-table td {
  color: var(--text-primary);
}

.settings-table tbody tr:hover {
  background: var(--button-bg);
}

.settings-info {
  color: var(--text-secondary);
  font-size: calc(var(--text-size) * 0.9);
  margin-bottom: calc(var(--unit-space) * 0.5);
}

.highlight {
  background-color: var(--accent);
  color: white;
  padding: 1px 2px;
  border-radius: 2px;
  font-weight: bold;
}

.modified-indicator {
  color: var(--accent);
  font-style: italic;
  font-size: calc(var(--text-size) * 0.85);
  margin-left: 5px;
}

.settings-table td input {
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
</style>