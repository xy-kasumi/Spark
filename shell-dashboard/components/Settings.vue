<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Settings</h1>
    <div class="widget-content">
      <button @click="refreshSettings" :disabled="!isIdle">REFRESH</button>
      <br />
      <div v-if="Object.keys(settings).length === 0" class="settings-placeholder">
        Click REFRESH to load settings
      </div>
      <div v-else>
        <label>Filter
          <input type="text" v-model="settingsFilter" placeholder="Enter filter..." /></label>
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
                <td>
                  <template v-if="keyParts(key).match">
                    {{ keyParts(key).before }}<span class="highlight">{{ keyParts(key).match }}</span>{{
                      keyParts(key).after }}
                  </template>
                  <template v-else>{{ key }}</template>
                </td>
                <td v-if="editingKey !== key" @click="startEditing(key)" style="cursor: pointer">
                  {{ value }}
                  <span v-if="isModified(key)" class="modified-indicator">(modified)</span>
                </td>
                <td v-else>
                  <input type="number" :value="value" @blur="saveEdit(key, $event)" @keyup.enter="saveEdit(key, $event)"
                    ref="editInput" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="pendingEditsCount > 0" style="margin-top: var(--unit-space)">
          <button @click="applyEdits" :disabled="!isIdle">APPLY EDITS</button>
          <button @click="discardEdits">DISCARD EDITS</button>
        </div>
        <div v-if="pendingEditsCount === 0" style="margin-top: var(--unit-space)">
          <button @click="saveAsInit">SAVE AS INIT</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { sleep, SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
}>();

const settingsMachine = ref<Record<string, number>>({});
const settingsLocal = ref<Record<string, number>>({});
const settingsFilter = ref("");
const editingKey = ref<string | null>(null);

const settings = computed(() => {
  const result: Record<string, number> = {};

  for (const [key, value] of Object.entries(settingsMachine.value)) {
    result[key] = value;
  }

  for (const [key, value] of Object.entries(settingsLocal.value)) {
    result[key] = value;
  }

  return result;
});

const filteredSettings = computed(() => {
  if (!settingsFilter.value.trim()) {
    return settings.value;
  }

  const filter = settingsFilter.value.toLowerCase();
  const filtered: Record<string, number> = {};

  for (const [key, value] of Object.entries(settings.value)) {
    if (key.toLowerCase().includes(filter)) {
      filtered[key] = value;
    }
  }

  return filtered;
});

const settingsCount = computed(() => {
  const total = Object.keys(settings.value).length;
  const filtered = Object.keys(filteredSettings.value).length;
  return { filtered, total };
});

const modifiedKeys = computed(() => {
  const modified: string[] = [];
  for (const [key, localValue] of Object.entries(settingsLocal.value)) {
    const machineValue = settingsMachine.value[key];
    if (machineValue !== undefined && localValue !== machineValue) {
      modified.push(key);
    }
  }
  return modified;
});

const pendingEditsCount = computed(() => {
  return modifiedKeys.value.length;
});

let escapeHandler: ((event: KeyboardEvent) => void) | null = null;

onMounted(() => {
  escapeHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      cancelEdit();
    }
  };
  document.addEventListener("keydown", escapeHandler);
});

onBeforeUnmount(() => {
  if (escapeHandler) {
    document.removeEventListener("keydown", escapeHandler);
  }
});

async function refreshSettings() {
  props.client.enqueueCommand("get");

  await sleep(500);

  const res = await props.client.getLatestPState("stg");
  if (res === null) {
    console.error("get didn't result in settings within 500ms");
    return;
  }

  const machineSettings = res.pstate as Record<string, number>;
  console.log("Machine settings retrieved:", machineSettings);

  settingsMachine.value = machineSettings;

  if (Object.keys(settingsLocal.value).length === 0) {
    settingsLocal.value = { ...machineSettings };
  } else {
    const newLocal: Record<string, number> = {};
    for (const [key, value] of Object.entries(settingsLocal.value)) {
      if (key in machineSettings) {
        newLocal[key] = value;
      }
    }
    settingsLocal.value = newLocal;
  }
}

function keyParts(key: string) {
  if (!settingsFilter.value.trim()) {
    return { before: "", match: "", after: "" };
  }

  const filter = settingsFilter.value.toLowerCase();
  const keyLower = key.toLowerCase();
  const index = keyLower.indexOf(filter);

  if (index === -1) {
    return { before: "", match: "", after: "" };
  }

  const before = key.substring(0, index);
  const match = key.substring(index, index + filter.length);
  const after = key.substring(index + filter.length);

  return { before, match, after };
}

function startEditing(key: string) {
  editingKey.value = key;
}

function saveEdit(key: string, event: Event) {
  const target = event.target as HTMLInputElement;
  const newValue = parseFloat(target.value);

  if (!isNaN(newValue)) {
    settingsLocal.value[key] = newValue;
  }

  editingKey.value = null;
}

function cancelEdit() {
  editingKey.value = null;
}

function isModified(key: string) {
  return modifiedKeys.value.includes(key);
}

async function applyEdits() {
  if (pendingEditsCount.value === 0) {
    return;
  }

  for (const key of modifiedKeys.value) {
    const value = settingsLocal.value[key];
    const command = `set ${key} ${value}`;
    props.client.enqueueCommand(command);
  }

  for (const key of modifiedKeys.value) {
    settingsMachine.value[key] = settingsLocal.value[key];
  }

  console.log(`Applied ${pendingEditsCount.value} setting changes`);
}

function discardEdits() {
  settingsLocal.value = { ...settingsMachine.value };
  editingKey.value = null;
  console.log("Discarded all pending edits");
}

async function saveAsInit() {
  try {
    const initLines: string[] = [];
    for (const [key, value] of Object.entries(settingsLocal.value)) {
      initLines.push(`set ${key} ${value}`);
    }

    await props.client.setInit(initLines);
    console.log(`Saved ${initLines.length} settings as init commands`);
  } catch (error) {
    console.error("Failed to save settings as init:", error);
  }
}
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