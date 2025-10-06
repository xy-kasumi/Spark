<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Coordinate System</h1>
    <div class="widget-content">
      <button @click="setMachineCoords">MACHINE</button>
      <button @click="setWorkCoords">WORK</button>
      <button @click="setGrinderCoords">GRINDER</button>
      <button @click="setToolSupplyCoords">TOOLSUPPLY</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
}>();

function setMachineCoords() {
  props.client.enqueueCommand("G53");
}

function setWorkCoords() {
  props.client.enqueueCommand("G55");
}

function setGrinderCoords() {
  props.client.enqueueCommand("G54");
}

function setToolSupplyCoords() {
  props.client.enqueueCommand("G56");
}
</script>