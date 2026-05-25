<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Add Job</h1>
    <div class="widget-content">
      <input
        ref="fileInput"
        type="file"
        accept=".gcode,.txt"
        style="display: none"
        @change="onFileChange"
      />
      <button class="" @click="fileInput?.click()">FROM FILE</button>
      <span v-if="commands.length > 0">{{ linesInfo }}</span><br />
      <button class="" @click="send" :disabled="commands.length === 0 || !isIdle">
        EXECUTE
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, useTemplateRef } from "vue";
import { SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
}>();

const emit = defineEmits<{
  "command-sent": [];
}>();

const commandText = ref("");
const fileInput = useTemplateRef<HTMLInputElement>("fileInput");

const commands = computed(() => {
  return commandText.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

const linesInfo = computed(() => {
  const count = commands.value.length;
  if (count === 0) return "";
  const firstCmd = commands.value[0];
  const preview = firstCmd.length > 20 ? firstCmd.slice(0, 20) : firstCmd;
  const kb = new Blob([commandText.value]).size / 1000;
  return `${count} lines, ${kb.toFixed(1)} kB (${preview}...)`;
});

async function onFileChange(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) {
    return;
  }
  try {
    commandText.value = await file.text();
  } catch (err) {
    console.error("Failed to read file:", err);
  }
  input.value = "";
}

function send() {
  if (commands.value.length === 0) {
    return;
  }

  props.client.addJob(commands.value, {
    "?pos": 1,
    "?edm": 0.5,
  });

  commandText.value = "";

  emit("command-sent");
}
</script>
