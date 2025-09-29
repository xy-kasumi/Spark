import * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

const fontLoader = new FontLoader();
let font: any = null;

const generateStockGeom = (): THREE.BufferGeometry => {
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
// path segments
const createPathVis = (path: any[]): THREE.Object3D => {
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
const createRotationAxisHelper = (axis: THREE.Vector3, size: number = 1, color: THREE.Color = axisColorA): THREE.Object3D => {
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
    const lToWMat3 = new THREE.Matrix3();
    lToWMat3.set(
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


const generateStock = (): THREE.Object3D => {
    const stock = new THREE.Mesh(
        generateStockGeom(),
        new THREE.MeshLambertMaterial({ color: "blue", wireframe: true, transparent: true, opacity: 0.05 }));
    return stock;
};

// Generate tool visualization with tool base origin = origin. tool is pointing towards Z-.
const generateTool = (toolLength: number): THREE.Object3D => {
    const toolOrigin = new THREE.Object3D();

    const baseRadius = 10;
    const baseHeight = 10;

    const toolRadius = 3 / 2;

    // note: cylinder geom is Y direction and centered. Need to rotate and shift.

    const base = new THREE.Mesh(
        new THREE.CylinderGeometry(baseRadius, baseRadius, baseHeight, 6, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xe0e0e0, metalness: 0.2, roughness: 0.8 }));
    base.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    base.position.z = baseHeight / 2;
    toolOrigin.add(base);

    const tool = new THREE.Mesh(
        new THREE.CylinderGeometry(toolRadius, toolRadius, toolLength, 32, 1),
        new THREE.MeshPhysicalMaterial({ color: 0xf0f0f0, metalness: 0.9, roughness: 0.3 }));
    tool.setRotationFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    tool.position.z = -toolLength / 2;
    toolOrigin.add(tool);

    const aAxisHelper = createRotationAxisHelper(new THREE.Vector3(0, 0, -1), 2, axisColorA); // TODO: is this polarity correct?
    toolOrigin.add(aAxisHelper);

    return toolOrigin;
};

/**
 * Parse single line of G-code (+ comments). Can containt comment-only or empty lines.
 */
const parseGCodeLine = (lineStr: string): GCodeLine | string => {
    const commentIdx = lineStr.indexOf(';');
    const blockStr = (commentIdx >= 0 ? lineStr.slice(0, commentIdx) : lineStr).trim();
    let block = undefined;
    if (blockStr.length > 0) {
        const res = parseGCodeBlock(blockStr);
        if (typeof res === 'string') {
            return `invalid block: ${res}`;
        }
        block = res;
    }
    return {
        origLine: lineStr,
        block: block,
    }
};

/**
 * Parse single block of G-code.
 * @param blockStr string like "G38.3 Z-5", "M4"
 * @returns parsed block or error string.
 */
const parseGCodeBlock = (blockStr: string): GCodeBlock | string => {
    const words = blockStr.split(' ').map(w => w.trim()).filter(w => w.length > 0);
    if (words.length === 0) {
        return "missing command";
    }

    const command = words[0];
    if (!command.startsWith('G') && !command.startsWith('M')) {
        return `invalid command: ${command}`;
    }

    const params = {};
    const flags = [];
    for (const paramWord of words.slice(1)) {
        if (paramWord.length === 1) {
            const axis = paramWord[0];
            if (flags.includes(axis) || params[axis] !== undefined) {
                return `duplicate flag: ${axis}`;
            }
            flags.push(axis);
        } else {
            const axis = paramWord[0];
            const numStr = paramWord.slice(1);
            const val = parseFloat(numStr);
            if (isNaN(val) || !isFinite(val)) {
                return `invalid value in word ${paramWord}: ${numStr}`;
            }
            if (flags.includes(axis) || params[axis] !== undefined) {
                return `duplicate axis: ${axis}`;
            }
            params[axis] = val;
        }
    }
    return { command, params, flags };
};

type GCodeLine = {
    origLine: string,
    block?: GCodeBlock,
}

type GCodeBlock = {
    command: string, // "G1", "G38.3", "M11" etc.
    params: Record<string, number>, // e.g. {X: 12.3} for "G1 X12.3"
    flags: string[], // e.g. ["X"] for "G28 X"
};


////////////////////////////////////////////////////////////////////////////////
// 3D view

type ColorMode = "type" | "dist";

/**
 * Scene is in mm unit. Right-handed, X+ up, machine coords.
 */
class View3D {
    // 3D view basis
    scene: THREE.Scene;
    camera: any;
    renderer: THREE.WebGLRenderer;
    container: HTMLElement;
    controls: OrbitControls;
    stats: any;

    // UI
    receiveBroadcast: boolean;
    gcodeChannel: BroadcastChannel;

    workOffset: THREE.Vector3;
    wireCenter: THREE.Vector3;
    stockCenter: THREE.Vector3;
    toolRemoverCenter: THREE.Vector3;
    toolBankOrigin: THREE.Vector3;

    workStageBase: THREE.Object3D;
    tool: THREE.Object3D;
    toolLength: number;
    toolDiameter: number;

    colorMode: ColorMode = "type";

    gcode: GCodeLine[] = [];
    totalGcodeLines: number = 0;

    pathVis: THREE.Object3D = null;

    constructor() {
        this.init();

        this.tool = generateTool(50);
        this.scene.add(this.tool);

        // machine-state setup
        this.toolLength = 25;
        this.toolDiameter = 1.5;

        this.receiveBroadcast = true;
        this.totalGcodeLines = 0;

        this.initGui();

        this.gcodeChannel = new BroadcastChannel("gcode");
        this.gcodeChannel.onmessage = (e) => {
            if (this.receiveBroadcast) {
                this.importGCode(e.data);
            } else {
                console.log(`broadcast (size=${e.data.length}) ignored`);
            }
        };
    }

    initGui(): void {
        const gui = new GUI();

        gui.add(this, "receiveBroadcast");
        gui.add(this, "pasteFromClipboard");

        gui.add(this, "totalGcodeLines").disable().listen();
        gui.add(this, "colorMode").options(["type", "dist"]).listen().onChange(() => {
            if (this.gcode.length > 0) {
                this.visualizeGCode(this.colorMode);
            }
        }); 
    }

    init(): void {
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
        this.container.appendChild(this.stats.dom);

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    pasteFromClipboard(): void {
        navigator.clipboard.readText().then(text => {
            this.importGCode(text);
        });
    }

    private importGCode(gcodeText: string) {
        const blocks = [];
        const errors = [];
        gcodeText.split("\n").forEach((l, ix) => {
            const res = parseGCodeLine(l);
            if (typeof res === 'string') {
                errors.push(`line ${ix + 1}: ${res}`);
            } else {
                blocks.push(res);
            }
        });
        if (errors.length > 0) {
            console.error(`G-code parse errors:\n${errors.join("\n")}`);
            return;
        }

        this.gcode = blocks;
        this.totalGcodeLines = this.gcode.length;

        this.visualizeGCode(this.colorMode);
    }

    private visualizeGCode(colorMode: "type" | "dist") {
        const blocks = this.gcode.filter(l => l.block !== undefined).map(l => l.block);
        const segs = []; // flattened list of path segments
        const segCols = [];
        
        const ptAfterMove = (curr: THREE.Vector3, params: Record<string, number>): THREE.Vector3 => {
            const next = curr.clone();
            if (params["X"] !== undefined) {
                next.x = params["X"];
            }
            if (params["Y"] !== undefined) {
                next.y = params["Y"];
            }
            if (params["Z"] !== undefined) {
                next.z = params["Z"];
            }
            return next;
        };
        const computeTotalLen = (): number => {
            let curr = new THREE.Vector3();
            let len = 0;
            for (const block of blocks) {
                if (block.command === "G0" || block.command === "G1") {
                    const next = ptAfterMove(curr, block.params);
                    len += next.distanceTo(curr);
                    curr = next;
                }
            }
            return len;
        };

        const colmap = (t: number): THREE.Color => {
            const fromCol = new THREE.Color(1, 0, 0);
            const toCol = new THREE.Color(0, 0, 1);
            return fromCol.clone().lerp(toCol, t);
        };

        const totLen = computeTotalLen();
        let currLen = 0;
        let curr = new THREE.Vector3();
        for (const block of blocks) {
            if (block.command === "G0" || block.command === "G1") {
                const next = ptAfterMove(curr, block.params);
                const currDist = currLen;
                currLen += next.distanceTo(curr);
                const nextDist = currLen;
                segs.push(curr, next);

                if (colorMode === "type") {
                    const segCol = new THREE.Color(block.command === "G0" ? "blue" : "red");
                    segCols.push(segCol, segCol);
                } else if (colorMode === "dist") {
                    const currCol = colmap(currDist / totLen);
                    const nextCol = colmap(nextDist / totLen);
                    segCols.push(currCol, nextCol);
                }
                
                curr = next;
            }
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs.flatMap(v => [v.x, v.y, v.z])), 3));
        geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segCols.flatMap(c => [c.r, c.g, c.b])), 3));
        const mat = new THREE.LineBasicMaterial({ vertexColors: true });
        const lineSegs = new THREE.LineSegments(geom, mat);

        if (this.pathVis) {
            this.scene.remove(this.pathVis);
        }
        this.pathVis = lineSegs;
        this.scene.add(lineSegs);
    }

    onWindowResize(): void {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate(): void {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}


////////////////////////////////////////////////////////////////////////////////
// entry point

const loadFont = async () => {
    return new Promise<void>((resolve) => {
        fontLoader.load("./assets/Source Sans 3_Regular.json", (f) => {
            font = f;
            resolve();
        });
    });
};

(async () => {
    await loadFont();
    const view = new View3D();
})();
