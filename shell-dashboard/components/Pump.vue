<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Pump</h1>
    <div class="widget-content">
      <button @click="start" :disabled="!isIdle">START</button>
      <button @click="stop" :disabled="!isIdle">STOP</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
}>();

function start() {
  props.client.enqueueCommand("M8");
}

function stop() {
  props.client.enqueueCommand("M9");
}
</script>
