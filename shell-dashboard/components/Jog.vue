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

<script>
import { spoolerApi } from "../spooler.ts";

export default {
  name: "Jog",
  props: {
    client: Object,
  },
  data() {
    return {
      jogStepMm: 1,
      pos: {},
      isPolling: false,
    };
  },
  mounted() {
    this.isPolling = true;
    this.pollPos();
  },
  beforeUnmount() {
    this.isPolling = false;
  },
  computed: {
    posLineLocal() {
      if (this.pos["sys"] === "machine") {
        return "";
      }

      const prefixTable = {
        grinder: "g",
        toolsupply: "t",
        work: "w",
      };
      const sys = this.pos["sys"];
      const prefix = prefixTable[sys];
      if (!prefix) {
        return `(${sys}) unknown`;
      }

      const x = this.pos[`${prefix}.x`];
      const y = this.pos[`${prefix}.y`];
      const z = this.pos[`${prefix}.z`];
      const c = this.pos[`${prefix}.c`];
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
    },

    posLineMachine() {
      const x = this.pos["m.x"];
      const y = this.pos["m.y"];
      const z = this.pos["m.z"];
      const c = this.pos["m.c"];
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
    },
  },
  methods: {
    async pollPos() {
      while (this.isPolling) {
        await this.updatePos();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },

    async updatePos() {
      if (!this.client) {
        return;
      }
      await this.client.enqueueCommand("?pos");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const host = "http://localhost:9000";
      const latestPos = await spoolerApi.getLatestPState(host, "pos");
      if (latestPos !== null) {
        this.pos = latestPos.pstate;
      }
    },

    refresh() {
      this.updatePos();
    },

    currentPos() {
      return {
        x: this.pos["m.x"],
        y: this.pos["m.y"],
        z: this.pos["m.z"],
      };
    },

    jogHome() {
      this.client.enqueueCommand("G28");
    },

    jogXPlus() {
      this.client.enqueueCommand(
        `G0 X${(this.currentPos().x + this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },

    jogXMinus() {
      this.client.enqueueCommand(
        `G0 X${(this.currentPos().x - this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },

    jogYPlus() {
      this.client.enqueueCommand(
        `G0 Y${(this.currentPos().y + this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },

    jogYMinus() {
      this.client.enqueueCommand(
        `G0 Y${(this.currentPos().y - this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },

    jogZPlus() {
      this.client.enqueueCommand(
        `G0 Z${(this.currentPos().z + this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },

    jogZMinus() {
      this.client.enqueueCommand(
        `G0 Z${(this.currentPos().z - this.jogStepMm).toFixed(3)}`
      );
      this.updatePos();
    },
  },
};
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