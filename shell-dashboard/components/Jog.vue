<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Jog</h1>
    <div class="widget-content">
      <button class="refresh-btn" @click="refresh">REFRESH</button>
      <br />
      <div>{{ posLineLocal }}</div>
      <div>(machine) {{ posStringMachine }}</div>
      <br />
      <table class="jog-table">
        <tr>
          <td></td>
          <td><button class="jog-btn" @click="jog('X', 1)" :disabled="!isIdle">X+</button></td>
          <td></td>
          <td></td>
          <td><button class="jog-btn" @click="jog('Z', -1)" :disabled="!isIdle">Z- (PUSH)</button></td>
        </tr>
        <tr>
          <td><button class="jog-btn" @click="jog('Y', 1)" :disabled="!isIdle">Y+</button></td>
          <td></td>
          <td><button class="jog-btn" @click="jog('Y', -1)" :disabled="!isIdle">Y-</button></td>
          <td><button class="jog-btn" @click="home" :disabled="!isIdle">HOME</button></td>
          <td><button class="jog-btn" @click="jog('Z', 1)" :disabled="!isIdle">Z+ (PULL)</button></td>
        </tr>
        <tr>
          <td></td>
          <td><button class="jog-btn" @click="jog('X', -1)" :disabled="!isIdle">X-</button></td>
          <td></td>
          <td></td>
          <td></td>
        </tr>
      </table>

      <div>
        <label class="">
          <input type="radio" name="jogStep" :value="0.1" v-model.number="jogStepMm" />
          0.1mm
        </label>
        <label class="">
          <input type="radio" name="jogStep" :value="1" v-model.number="jogStepMm" />
          1mm
        </label>
        <label class="">
          <input type="radio" name="jogStep" :value="5" v-model.number="jogStepMm" />
          5mm
        </label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { sleep, SpoolerClient } from "../spooler";

// Basic data structure

type Coords = { x: number, y: number, z: number, c: number };
type CoordSys = "machine" | "grinder" | "toolsupply" | "work";

type Pos = {
  machine: Coords;
  currSys: CoordSys;
  local: Coords;
};

type Axis = "X" | "Y" | "Z" | "C";

const getElementByAxis = (p: Coords, axis: Axis): number => {
  switch (axis) {
    case "X": return p.x;
    case "Y": return p.y;
    case "Z": return p.z;
    case "C": return p.c;
  }
};

// Spooler <-> data

const formatCoords = (p: Coords): string => {
  return `X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z${p.z.toFixed(3)} C${p.c.toFixed(3)}`;
};

const extractCoords = (ps: Record<string, any>, sys: CoordSys): Coords | null => {
  const table: Record<CoordSys, string> = {
    machine: "m",
    grinder: "g",
    toolsupply: "t",
    work: "w",
  };
  const prefix = table[sys];
  const xval = ps[`${prefix}.x`];
  const yval = ps[`${prefix}.y`];
  const zval = ps[`${prefix}.z`];
  const cval = ps[`${prefix}.c`];
  if (xval === undefined || yval === undefined || zval === undefined || cval === undefined) {
    return null;
  }
  return {
    x: xval,
    y: yval,
    z: zval,
    c: cval,
  };
};

const extractPos = (ps: Record<string, any>): Pos | null => {
  const sys: CoordSys = ps["sys"];
  const machinePos = extractCoords(ps, "machine");
  const localPos = extractCoords(ps, sys);
  if (!machinePos || !localPos) {
    return null;
  }
  return {
    machine: machinePos,
    currSys: sys,
    local: localPos,
  };
};

// Vue UI
const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
}>();

const jogStepMm = ref(1);
const pos = ref<Pos | null>(null);
const isPolling = ref(false);

onMounted(() => {
  isPolling.value = true;
  pollPos();
});

onBeforeUnmount(() => {
  isPolling.value = false;
});

const posLineLocal = computed(() => {
  const val = pos.value;
  if (!val) {
    return "";
  }
  if (val.currSys === "machine") {
    return "";
  }
  return `(${val.currSys}) ${formatCoords(val.local)}`;
});

const posStringMachine = computed(() => {
  return pos.value ? formatCoords(pos.value.machine) : "unknown";
});

async function pollPos() {
  while (isPolling.value) {
    await updatePos();
    await sleep(1000);
  }
}

async function updatePos() {
  await props.client.enqueueCommand("?pos");
  await sleep(50);
  const latestPos = await props.client.getLatestPState("pos");
  if (latestPos === null) {
    return;
  }
  pos.value = extractPos(latestPos.pstate);
}

function refresh() {
  updatePos();
}

function home() {
  props.client.enqueueCommand("G28");
}

function jog(axis: Axis, dir: -1 | 1) {
  if (!pos.value) {
    return;
  }
  const newP = getElementByAxis(pos.value.local, axis) + jogStepMm.value * dir;
  props.client.enqueueCommand(`G0 ${axis}${newP.toFixed(3)}`);
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