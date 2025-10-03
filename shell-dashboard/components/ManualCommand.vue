<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Manual Command</h1>
    <div class="widget-content">
      <button class="" @click="init">{{ initButtonText }}</button>
      <br />
      <textarea
        class=""
        v-model="commandText"
        rows="10"
        cols="50"
        placeholder="Enter G-code or commands"
      ></textarea
      ><br />
      <button
        class=""
        @click="send"
        :disabled="commands.length === 0 || !assumeInitialized"
      >
        {{ executeButtonText }}
      </button>
      <label class="">
        <input type="checkbox" v-model="clearOnExec" /> Clear on exec
      </label>
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
const clearOnExec = ref(true);

const commands = computed(() => {
  return commandText.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
});

const initButtonText = computed(() => {
  return props.clientStatus === "idle" ? "INIT" : "ENQUEUE INIT";
});

const executeButtonText = computed(() => {
  return props.clientStatus === "idle" ? "EXECUTE" : "ENQUEUE";
});

async function init() {
  if (!props.client) {
    return;
  }

  const host = "http://localhost:9000";
  const initData = await spoolerApi.getInit(host);
  for (const cmd of initData.lines) {
    props.client.enqueueCommand(cmd);
  }
}

function send() {
  if (!props.client || commands.value.length === 0) {
    return;
  }

  props.client.enqueueCommands(commands.value);

  if (clearOnExec.value) {
    commandText.value = "";
  }

  emit("command-sent");
}
</script>