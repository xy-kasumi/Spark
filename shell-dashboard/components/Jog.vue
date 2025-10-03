<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Jog</h1>
    <div class="widget-content">
      <button class="refresh-btn" @click="refresh">REFRESH</button>
      <br />
      <div>{{ posLineLocal }}</div>
      <div>{{ posLineMachine }}</div>
      <br />
      <table class="jog-table">
        <tr>
          <td></td>
          <td><button class="jog-btn" @click="jogXPlus">X+</button></td>
          <td></td>
          <td></td>
          <td><button class="jog-btn" @click="jogZMinus">Z- (PUSH)</button></td>
        </tr>
        <tr>
          <td><button class="jog-btn" @click="jogYPlus">Y+</button></td>
          <td></td>
          <td><button class="jog-btn" @click="jogYMinus">Y-</button></td>
          <td><button class="jog-btn" @click="jogHome">HOME</button></td>
          <td><button class="jog-btn" @click="jogZPlus">Z+ (PULL)</button></td>
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
          <input
            type="radio"
            name="jogStep"
            :value="0.1"
            v-model.number="jogStepMm"
          />
          0.1mm
        </label>
        <label class="">
          <input
            type="radio"
            name="jogStep"
            :value="1"
            v-model.number="jogStepMm"
          />
          1mm
        </label>
        <label class="">
          <input
            type="radio"
            name="jogStep"
            :value="5"
            v-model.number="jogStepMm"
          />
          5mm
        </label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { spoolerApi } from "../spooler";
import type { SpoolerController } from "../spooler";

const props = defineProps<{
  client?: SpoolerController;
}>();

const jogStepMm = ref(1);
const pos = ref<Record<string, any>>({});
const isPolling = ref(false);

onMounted(() => {
  isPolling.value = true;
  pollPos();
});

onBeforeUnmount(() => {
  isPolling.value = false;
});

const posLineLocal = computed(() => {
  if (pos.value["sys"] === "machine") {
    return "";
  }

  const prefixTable: Record<string, string> = {
    grinder: "g",
    toolsupply: "t",
    work: "w",
  };
  const sys = pos.value["sys"];
  const prefix = prefixTable[sys];
  if (!prefix) {
    return `(${sys}) unknown`;
  }

  const x = pos.value[`${prefix}.x`];
  const y = pos.value[`${prefix}.y`];
  const z = pos.value[`${prefix}.z`];
  const c = pos.value[`${prefix}.c`];
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    c === undefined
  ) {
    return `(${sys}) unknown`;
  }
  return `(${sys}) X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(
    3
  )} C${c.toFixed(3)}`;
});

const posLineMachine = computed(() => {
  const x = pos.value["m.x"];
  const y = pos.value["m.y"];
  const z = pos.value["m.z"];
  const c = pos.value["m.c"];
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    c === undefined
  ) {
    return "(machine) unknown";
  }
  return `(machine) X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(
    3
  )} C${c.toFixed(3)}`;
});

async function pollPos() {
  while (isPolling.value) {
    await updatePos();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function updatePos() {
  if (!props.client) {
    return;
  }
  await props.client.enqueueCommand("?pos");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const host = "http://localhost:9000";
  const latestPos = await spoolerApi.getLatestPState(host, "pos");
  if (latestPos !== null) {
    pos.value = latestPos.pstate;
  }
}

function refresh() {
  updatePos();
}

function currentPos() {
  return {
    x: pos.value["m.x"],
    y: pos.value["m.y"],
    z: pos.value["m.z"],
  };
}

function jogHome() {
  props.client?.enqueueCommand("G28");
}

function jogXPlus() {
  props.client?.enqueueCommand(
    `G0 X${(currentPos().x + jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}

function jogXMinus() {
  props.client?.enqueueCommand(
    `G0 X${(currentPos().x - jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}

function jogYPlus() {
  props.client?.enqueueCommand(
    `G0 Y${(currentPos().y + jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}

function jogYMinus() {
  props.client?.enqueueCommand(
    `G0 Y${(currentPos().y - jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}

function jogZPlus() {
  props.client?.enqueueCommand(
    `G0 Z${(currentPos().z + jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}

function jogZMinus() {
  props.client?.enqueueCommand(
    `G0 Z${(currentPos().z - jogStepMm.value).toFixed(3)}`
  );
  updatePos();
}
</script>

<style scoped>
.jog-table {
  border-spacing: calc(var(--unit-space) * 0.5);
  margin-bottom: var(--unit-space);
}

.jog-table td {
  width: calc(var(--unit-space) * 6);
  height: calc(var(--unit-space) * 6);
  text-align: center;
  vertical-align: middle;
  padding: 0;
}

.jog-btn {
  width: calc(var(--unit-space) * 6);
  height: calc(var(--unit-space) * 6);
  padding: 0;
  margin: 0;
}
</style>