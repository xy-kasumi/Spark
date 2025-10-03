<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Tool Supply</h1>
    <div class="widget-content">
      <div style="margin-bottom: var(--unit-space)">
        <label class="">
          <input type="checkbox" v-model="toolSupplyShowDetails" /> Individual
          actions
        </label>
      </div>

      <div v-if="!toolSupplyShowDetails">
        <button class="" @click="executeAttach">ATTACH</button>
        <button class="" @click="executeDetach">DETACH</button>
      </div>

      <div v-if="toolSupplyShowDetails">
        <div style="margin-bottom: var(--unit-space)">
          ATTACH
          <br />
          <div>
            <button class="" @click="moveToTs">MOVE</button>
            <button class="" @click="open">OPEN</button>
            <button class="" @click="tsInsert">INSERT</button>
            <button class="" @click="clamp">CLAMP</button>
            <button class="" @click="tsPull">PULL</button>
            <button class="" @click="close">CLOSE</button>
          </div>
        </div>
        <div style="margin-bottom: var(--unit-space)">
          DETACH
          <br />
          <div>
            <button class="" @click="moveToTs">MOVE</button>
            <button class="" @click="tsInsert">INSERT</button>
            <button class="" @click="unclamp">UNCLAMP</button>
            <button class="" @click="tsPull">PULL</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { SpoolerController } from "../spooler";

const tsJustBeforeInsertZ = 0;
const tsPulledZ = 47;
const tsFullInsertZ = -12;

const props = defineProps<{
  client?: SpoolerController;
}>();

const toolSupplyShowDetails = ref(false);

function clamp() {
  [
    "G0 C0",
    "G0 C240",
    "G0 C120",
    "G0 C0",
    "G0 C240",
    "G0 C120",
    "G0 C0",
  ].forEach((cmd) => props.client?.enqueueCommand(cmd));
}

function unclamp() {
  props.client?.enqueueCommands(["G0 C0", "G0 C120", "G0 C240", "G0 C0"]);
}

function open() {
  props.client?.enqueueCommand("M60");
}

function close() {
  props.client?.enqueueCommand("M61");
}

function moveToTs() {
  props.client?.enqueueCommands(["G56", `G0 X0 Y0 Z${tsPulledZ.toFixed(3)}`]);
}

function tsInsert() {
  const cmds = [];
  cmds.push("G56");
  cmds.push(`G0 Z${tsJustBeforeInsertZ.toFixed(3)}`);

  const halfWidth = 0.25;
  const quarterPitch = 0.1;
  const durZ = Math.abs(tsFullInsertZ - tsJustBeforeInsertZ);
  const dirZ = Math.sign(tsFullInsertZ - tsJustBeforeInsertZ);

  let ofs = 0;
  let phase = 0;
  let offsets = [
    [-1, -1],
    [-1, 1],
    [1, 1],
    [1, -1],
  ];
  while (true) {
    const [dx, dy] = offsets[phase];
    const x = dx * halfWidth;
    const y = dy * halfWidth;
    const z = tsJustBeforeInsertZ + ofs * dirZ;
    cmds.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z${z.toFixed(3)}`);

    const nextOfs = ofs + quarterPitch;
    if (nextOfs >= durZ) {
      break;
    } else {
      phase = (phase + 1) % 4;
      ofs += quarterPitch;
    }
  }

  cmds.push(`G0 X0 Y0 Z${tsFullInsertZ.toFixed(3)}`);
  props.client?.enqueueCommands(cmds);
}

function tsPull() {
  props.client?.enqueueCommands([`G0 Z${tsPulledZ.toFixed(3)}`, "G53"]);
}

function executeAttach() {
  moveToTs();
  open();
  tsInsert();
  clamp();
  tsPull();
  close();
}

function executeDetach() {
  moveToTs();
  tsInsert();
  unclamp();
  tsPull();
}
</script>