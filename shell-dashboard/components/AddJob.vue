<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Add Job</h1>
    <div class="widget-content">
      <button class="" @click="pasteFromClipboard">PASTE FROM CLIPBOARD</button>
      <span v-if="commands.length > 0">{{ linesInfo }}</span
      ><br />
      <button
        class=""
        @click="send"
        :disabled="commands.length === 0 || !assumeInitialized"
      >
        {{ executeButtonText }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { spoolerApi } from "../spooler";
import type { SpoolerController } from "../spooler";

const props = defineProps<{
  client?: SpoolerController;
  clientStatus?: string;
  assumeInitialized?: boolean;
}>();

const emit = defineEmits<{
  "command-sent": [];
}>();

const commandText = ref("");

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
  return `${count} lines (${preview}...)`;
});

const executeButtonText = computed(() => {
  return props.clientStatus === "idle" ? "EXECUTE" : "ENQUEUE";
});

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    commandText.value = text;
  } catch (err) {
    console.error("Failed to read clipboard:", err);
  }
}

function send() {
  if (!props.client || commands.value.length === 0) {
    return;
  }

  const host = "http://localhost:9000";
  spoolerApi.addJob(host, commands.value, {
    "?pos": 1,
    "?edm": 0.5,
  });

  commandText.value = "";

  emit("command-sent");
}
</script>
