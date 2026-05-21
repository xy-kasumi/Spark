<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Pump</h1>
    <div class="widget-content">
      <label>
        <input type="checkbox" v-model="enabled" @change="apply" />
        Enable (override)
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
}>();

const enabled = ref(false);

function apply() {
  // true enables pump; false respects M8/M9. Sent immediately (not queued).
  props.client.sendSignal(`fset ov.pump_en ${enabled.value}`);
}
</script>
