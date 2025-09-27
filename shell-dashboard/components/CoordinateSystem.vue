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

<script>
export default {
  name: "CoordinateSystem",
  props: {
    client: Object,
  },
  methods: {
    setMachineCoords() {
      this.client.enqueueCommand("G53");
      this.client.requestPosUpdate();
    },

    setWorkCoords() {
      this.client.enqueueCommand("G55");
      this.client.requestPosUpdate();
    },

    setGrinderCoords() {
      this.client.enqueueCommand("G54");
      this.client.requestPosUpdate();
    },

    setToolSupplyCoords() {
      this.client.enqueueCommand("G56");
      this.client.requestPosUpdate();
    },
  },
};
</script>