import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const fontLoader = new FontLoader();
let font = null;

// returns: THREE.BufferGeometry
const generateStockGeom = () => {
    const stockRadius = 7.5;
    const stockHeight = 15;
    const geom = new THREE.CylinderGeometry(stockRadius, stockRadius, stockHeight, 64, 1);
    const transf = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, stockHeight / 2),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2),
        new THREE.Vector3(1, 1, 1));
    geom.applyMatrix4(transf);
    return geom;
};


// Visualize tool tip path in machine coordinates.
//
// [in] array of THREE.Vector3, path segments
// returns: THREE.Object3D
const createPathVis = (path) => {
    if (path.length === 0) {
        return new THREE.Object3D();
    }

    const vs = [];
    let prevTipPosM = path[0].tipPosM;
    for (let i = 1; i < path.length; i++) {
        const pt = path[i];
        if (pt.type === "remove-work") {
            vs.push(prevTipPosM.x, prevTipPosM.y, prevTipPosM.z);
            vs.push(pt.tipPosM.x, pt.tipPosM.y, pt.tipPosM.z);
        }
        prevTipPosM = pt.tipPosM;
    }

    const pathVis = new THREE.Object3D();

    // add remove path vis
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vs), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x808080 });
    pathVis.add(new THREE.LineSegments(geom, mat));

    // add refresh path vis
    const sphGeom = new THREE.SphereGeometry(0.15);
    const sphMat = new THREE.MeshBasicMaterial({ color: 0x606060 });
    for (let i = 0; i < path.length; i++) {
        const pt = path[i];
        
        if (pt.type !== "remove-work") {
            const sph = new THREE.Mesh(sphGeom, sphMat);
            sph.position.copy(pt.tipPosM);
            pathVis.add(sph);
        }
    }

    return pathVis;
};

// orange-teal-purple color palette for ABC axes.
const axisColorA = new THREE.Color(0xe67e22);
const axisColorB = new THREE.Color(0x1abc9c);
const axisColorC = new THREE.Color(0x9b59b6);

// Creates ring+axis rotational axis visualizer.
// [in] axis THREE.Vector3. rotates around this axis in CCW.
// [in] size number feature size. typically ring radius.
// [in] color THREE.Color
// returns: THREE.Object3D
const createRotationAxisHelper = (axis, size = 1, color = axisColorA) => {
    const NUM_RING_PTS = 32;

    /////
    // contsutuct axis & ring out of line segments

    // Generate as Z+ axis, scale=1 and rotate & re-scale later.
    const buffer = new THREE.BufferGeometry();
    const pts = [];
    // add axis
    pts.push(0, 0, -1);
    pts.push(0, 0, 1);
    // add ring
    for (let i = 0; i < NUM_RING_PTS; i++) {
        const angle0 = 2 * Math.PI * i / NUM_RING_PTS;
        const angle1 = 2 * Math.PI * (i + 1) / NUM_RING_PTS;
        pts.push(Math.cos(angle0), Math.sin(angle0), 0);
        pts.push(Math.cos(angle1), Math.sin(angle1), 0);
    }
    buffer.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    const lineSegs = new THREE.LineSegments(buffer, new THREE.LineBasicMaterial({ color }));

    /////
    // construct direction cones
    const geom = new THREE.ConeGeometry(0.1, 0.2);
    const coneMat = new THREE.MeshBasicMaterial({ color });
    const cone0 = new THREE.Mesh(geom, coneMat);
    const cone1 = new THREE.Mesh(geom, coneMat);
    
    const localHelper = new THREE.Object3D();
    localHelper.add(lineSegs);
    localHelper.add(cone0);
    cone0.position.set(0.99, 0, 0);

    localHelper.add(cone1);
    cone1.scale.set(1, -1, 1);
    cone1.position.set(-0.99, 0, 0);

    ///// 
    // scale & rotate

    // create orthonormal basis for rotation.
    const basisZ = axis.normalize();
    let basisY;
    const b0 = new THREE.Vector3(1, 0, 0);
    const b1 = new THREE.Vector3(0, 1, 0);
    if (b0.clone().cross(basisZ).length() > 0.3) {
        basisY = b0.clone().cross(basisZ).normalize();
    } else {
        basisY = b1.clone().cross(basisZ).normalize();
    }
    const basisX = basisY.clone().cross(basisZ).normalize();

    // init new grid
    const lToWMat3 = new THREE.Matrix3(
        basisX.x, basisY.x, basisZ.x,
        basisX.y, basisY.y, basisZ.y,
        basisX.z, basisY.z, basisZ.z,
    );

    const helper = new THREE.Object3D();
    helper.add(localHelper);

    localHelper.scale.set(size, size, size);
    localHelper.applyMatrix4(new THREE.Matrix4().identity().setFromMatrix3(lToWMat3));
    return helper;
};


// returns: THREE.Object3D
const generateStock = () => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};

// Generate tool visualization with tool base origin = origin. tool is pointing towards Z-.
// returns: THREE.Object3D
const generateTool = (toolLength) => {
    const toolOrigin = new THREE.Object3D();

    const baseRadius = 10;
    const baseHeight = 10;

    const toolRadius = 1.5 / 2;

    // note: cylinder geom is Y direction and centered. Need to rotate and shift.

    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, baseHeight, 6, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8, wireframe: true }));
    base.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    base.position.z = baseHeight / 2;
    toolOrigin.add(base);

    const tool = new THREE.Mesh(
        new THREE.CylinderGeometry(toolRadius, toolRadius, toolLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3, wireframe: true }));
    tool.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    tool.position.z = -toolLength / 2;
    toolOrigin.add(tool);

    const aAxisHelper = createRotationAxisHelper(new THREE.Vector3(0, 0, -1), 2, axisColorA); // TODO: is this polarity correct?
    toolOrigin.add(aAxisHelper);

    const bAxisHelper1 = createRotationAxisHelper(new THREE.Vector3(0, 1, 0), 5, axisColorB);
    const bAxisHelper2 = createRotationAxisHelper(new THREE.Vector3(0, 1, 0), 5, axisColorB);
    bAxisHelper1.position.set(0, 1, 0);
    bAxisHelper2.position.set(0, -1, 0);
    toolOrigin.add(bAxisHelper1);
    toolOrigin.add(bAxisHelper2);

    return toolOrigin;
};

// Parse single line of G-code.
// [in] line string
// [in] {X, Y, Z, A, B, C, GW_ABS} current values
// returns: {dur: number, goal: {X, Y, Z, A, B, C, GW_ABS}} | null (if g code is empty e.g. comment or M-command)
const parseGcode = (line, curr) => {
    const ix = line.indexOf(";");
    const activePart = ix >= 0 ? line.substring(0, ix) : line;
    const tokens = activePart.split(" ").filter(t => t);
    if (tokens.length === 0) {
        return null;
    }

    const command = tokens[0];
    if (command === "G0" || command === "G1") {
        const axes = ["X", "Y", "Z", "A", "B", "C", "GW", "D"];
        const absAxes = ["X", "Y", "Z", "B", "C"];

        const rawGoal = {};
        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            const axis = token.match(/^[A-Z]+/)[0];
            const val = parseFloat(token.substring(axis.length));
            if (!axes.includes(axis)) {
                throw new Error(`unknown axis: ${axis}, in ${line}`);
            }
            if (rawGoal[axis] !== undefined) {
                throw new Error(`duplicate axis: ${axis}, in ${line}`);
            }
            rawGoal[axis] = val;
        }
        if (rawGoal.A !== undefined && rawGoal.D !== undefined) {
            throw new Error(`A and D cannot be set at the same time, in ${line}`);
        }

        const goal = {};
        absAxes.forEach(axis => {
            goal[axis] = rawGoal[axis] === undefined ? curr[axis] : rawGoal[axis];
        });
        if (rawGoal.A !== undefined) {
            goal.A = rawGoal.A;
        } else {
            goal.A = curr.A + (rawGoal.D || 0);
        }
        goal.GW_ABS = curr.GW_ABS + (rawGoal.GW || 0);

        const dur = 1; // TODO: change by distance and G0 vs G1
        return {dur, goal};
    } else {
        // TODO: handle properly
        console.log(`unhandled command: ${command}`);
        return null;
    }
};

// Linearly interpolate between two values. Note interpolation happens independently for each axis.
// [in] a {X, Y, Z, A, B, C, GW_ABS}
// [in] b {X, Y, Z, A, B, C, GW_ABS}
// [in] t number, 0 <= t <= 1
// returns: {X, Y, Z, A, B, C, GW_ABS}
const lerpVals = (a, b, t) => {
    const lerp = (a, b, t) => a + (b - a) * t;
    return {
        X: lerp(a.X, b.X, t),
        Y: lerp(a.Y, b.Y, t),
        Z: lerp(a.Z, b.Z, t),
        A: lerp(a.A, b.A, t),
        B: lerp(a.B, b.B, t),
        C: lerp(a.C, b.C, t),
        GW_ABS: lerp(a.GW_ABS, b.GW_ABS, t),
    };
};


////////////////////////////////////////////////////////////////////////////////
// 3D view

/**
 * Scene is in mm unit. Right-handed, Z+ up.
 */
class View3D {
    constructor() {
        this.init();

        // machine geometries
        this.workOffset = new THREE.Vector3(20, 40, 20); // in machine coords
        this.wireCenter = new THREE.Vector3(30, 15, 30);
        this.stockCenter = new THREE.Vector3(10, 10, 10);

        // machine setup
        const opBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(70, 100, 60));
        this.scene.add(new THREE.Box3Helper(opBox, new THREE.Color(0x000000)));

        const wireBox = new THREE.Box3();
        wireBox.setFromCenterAndSize(this.wireCenter, new THREE.Vector3(1, 20, 1));
        this.scene.add(new THREE.Box3Helper(wireBox, new THREE.Color(0x000000)));

        const axesHelper = new THREE.AxesHelper(10);
        this.scene.add(axesHelper);
        axesHelper.position.set(0.1, 0.1, 0.1); // increase visibility by slight offset

        const textGeom = new TextGeometry("machine", {
            font,
            size: 2,
            depth: 0.1,
        });
        const textMesh = new THREE.Mesh(textGeom, new THREE.MeshBasicMaterial({ color: "#222222" }));
        this.scene.add(textMesh);

        const workStageBox = new THREE.Box3();
        workStageBox.setFromCenterAndSize(new THREE.Vector3(0, 0, -5), new THREE.Vector3(20, 20, 10));
        this.workStageBase = new THREE.Object3D();
        this.workStageBase.position.copy(this.workOffset);
        this.workStageBase.add(new THREE.Box3Helper(workStageBox, new THREE.Color(0x000000)));
        this.scene.add(this.workStageBase);

        this.tool = generateTool(25);
        this.scene.add(this.tool);

        // machine-state setup
        this.toolLength = 25;
        this.toolDiameter = 1.5;
        this.workCRot = 0;
        this.toolARot = 0;
        this.toolBRot = 0;

        const initialVals = {X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0, GW_ABS: 0};
        this.prevPt = initialVals;
        this.nextPt = initialVals;
        this.applyVals(initialVals);

        this.speed = 0.02;
        this.segmentDur = 0;
        this.segmentT = 0;

        this.valX = 0;
        this.valY = 0;
        this.valZ = 0;
        this.valA = 0;
        this.valB = 0;
        this.valC = 0;
        this.valGW = 0;
        this.valD = 0;

        const stock = generateStock();
        this.workStageBase.add(stock);

        this.gcode = [];
        this.receiveBroadcast = true;
        this.totalGcodeLines = 0;
        this.currentGcodeLine = 0;
        this.executingGcode = "";
        this.running = false;

        this.initGui();

        this.gcodeChannel = new BroadcastChannel("gcode");
        this.gcodeChannel.onmessage = (e) => {
            if (this.receiveBroadcast) {
                this.gcode = e.data.split("\n");
                this.totalGcodeLines = this.gcode.length;
                this.currentGcodeLine = 0;
                this.run();
            } else {
                console.log(`broadcast (size=${e.data.length}) ignored`);
            }
        };
    }

    initGui() {
        const gui = new GUI();
        
        gui.add(this, "receiveBroadcast");
        gui.add(this, "pasteFromClipboard");

        gui.add(this, "totalGcodeLines").disable().listen();
        gui.add(this, "currentGcodeLine").disable().listen();
        gui.add(this, "executingGcode").disable().listen();

        gui.add(this, "speed", 0, 1, 0.01);
        gui.add(this, "reset");
        gui.add(this, "run");
        gui.add(this, "pause");

        gui.add(this, "valX").decimals(3).name("X").listen();
        gui.add(this, "valY").decimals(3).name("Y").listen();
        gui.add(this, "valZ").decimals(3).name("Z").listen();
        gui.add(this, "valA").decimals(3).name("A").listen();
        gui.add(this, "valB").decimals(3).name("B").listen();
        gui.add(this, "valC").decimals(3).name("C").listen();
        gui.add(this, "valGWAbs").decimals(3).name("GW(abs)").listen();
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-25 * aspect, 25 * aspect, 25, -25, -150, 150);
        this.camera.position.x = 15;
        this.camera.position.y = 40;
        this.camera.position.z = 20;
        this.camera.up.set(1, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(width, height);
        this.renderer.setAnimationLoop(() => this.animate());
        this.container = document.getElementById('container');
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff);

        const light = new THREE.AmbientLight(0x404040); // soft white light
        this.scene.add(light);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 0, 1);
        this.scene.add(directionalLight);

        const hemiLight = new THREE.HemisphereLight(0xffffbb, 0x080820, 1);
        this.scene.add(hemiLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.stats = new Stats();
        container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    pasteFromClipboard() {
        this.running = false;
        this.currentGcodeLine = 0;

        navigator.clipboard.readText().then(text => {
            this.gcode = text.split("\n");
            this.totalGcodeLines = this.gcode.length;
            this.currentGcodeLine = 0;
        });
    }

    reset() {
        this.currentGcodeLine = 0;
        this.running = false;
    }

    run() {
        this.running = true;
    }

    pause() {
        this.running = false;
    }

    step() {
        if (this.currentGcodeLine >= this.totalGcodeLines) {
            this.running = false;
            return;
        }

        this.segmentT += this.speed;
        if (this.segmentT >= this.segmentDur) {
            // proceed to next segment
            const line = this.gcode[this.currentGcodeLine];
            this.executingGcode = line;
            this.currentGcodeLine++;

            const command = parseGcode(line, this.nextPt);
            if (command === null) {
                return; // let next step() handle it.
            }
            
            this.prevPt = this.nextPt;
            this.nextPt = command.goal;
            
            this.segmentDur = command.dur;
            this.segmentT = 0;

            this.applyVals(this.prevPt);
        } else {
            // play interpolated value.
            const currVal = lerpVals(this.prevPt, this.nextPt, this.segmentT / this.segmentDur);
            this.applyVals(currVal);
        }
    }

    applyVals(vals) {
        this.tool.position.set(vals.X, vals.Y, vals.Z);
        this.tool.setRotationFromEuler(new THREE.Euler(0, vals.B / 180 * Math.PI, vals.A / 180 * Math.PI));

        this.workStageBase.setRotationFromAxisAngle(new THREE.Vector3(0, 0, 1), vals.C / 180 * Math.PI);
        
        // TODO: GW

        this.valX = vals.X;
        this.valY = vals.Y;
        this.valZ = vals.Z;
        this.valA = vals.A;
        this.valB = vals.B;
        this.valC = vals.C;
        this.valGWAbs = vals.GW_ABS;
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate() {
        if (this.running) {
            this.step();
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point

const loadFont = async () => {
    return new Promise((resolve) => {
        fontLoader.load("./Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
