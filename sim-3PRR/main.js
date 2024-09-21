import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const railLength = 200;
const railHeightX = 100;
const spindleSlant = 10;
const linkLength = 75;
const effectorLength = 20;

let eLPrev = null;
let eRPrev = null;

const mech = {
    z1: 50,
    z2: 90,
    z3: 60,
    toolBaseZ: 0,
    toolBaseX: 0,
    toolAngle: 0,

    minAngle: 0,
    usableX: 0,
    usableZ: 0,
    compute: () => {
        const usable = findUsableRange();
        console.log(usable);
        mech.usableX = usable.x;
        mech.usableZ = usable.z;
    },
};

// Returns: true if the solution is valid, false otherwise.
function solveIK() {
    const h = Math.abs(mech.toolBaseX - railHeightX);
    const baseHalfW = Math.sqrt(linkLength * linkLength - h * h);
    if (isNaN(baseHalfW)) {
        return false;
    }

    mech.z1 = mech.toolBaseZ - baseHalfW;
    mech.z2 = mech.toolBaseZ + baseHalfW;

    const theta = (mech.toolAngle - spindleSlant) / 180 * Math.PI;
    const eRZ = mech.toolBaseZ + Math.cos(theta) * effectorLength;
    const eRX = (railHeightX - mech.toolBaseX) - Math.sin(theta) * effectorLength;
    const dz = Math.sqrt(linkLength * linkLength - eRX * eRX);
    if (isNaN(dz)) {
        return false;
    }
    mech.z3 = eRZ - dz;
    return true;
}

// Returns: {z, x} (movable region)
function findUsableRange() {
    const minAngleDeg = 17;
    const railMargin = 6 + 19 / 2 + 1; // support + LB half width + margin

    const scanX = () => {
        let inRange = false;
        let xMin = null;
        let xMax = null;
        for (let x = 0; x < 100; x += 0.5) {
            let angleOk = true;
            for (let angle = 0; angle <= 90; angle += 10) {
                mech.toolBaseX = x;
                mech.toolAngle = angle;
                const ok = solveIK();
                if (!ok) {
                    angleOk = false;
                    break;
                }
                const pos = solveFK();
                if (pos === null || pos.minAngle < minAngleDeg * Math.PI / 180 || pos.railEndMargin < railMargin) {
                    angleOk = false;
                    break;
                }
            }
    
            if (!inRange) {
                if (angleOk) {
                    inRange = true;
                    xMin = x;
                }
            } else {
                if (!angleOk) {
                    xMax = x - 0.5;
                    break;
                }
            }
        }
        if (xMin === null) {
            return {x: 0, xMin: 0, xMax: 0};
        }
        if (xMax === null) {
            console.log("Failed to compute range / X scan didn't finish; setting max value");
            xMax = 100 - 0.5;
        }
        return {x: xMax - xMin, xMin, xMax};
    };

    mech.toolBaseZ = 100; // center-ish value (maximum x range)
    const res = scanX();
    if (res.x === 0) {
        return {x: 0, z: 0};
    }
    let inRange = false;
    let zMin = null;
    let zMax = null;
    for (let z = 40; z < 150; z += 0.5) {
        mech.toolBaseZ = z;
        const curr = scanX();
        const ok = curr.xMin <= res.xMin && curr.xMax >= res.xMax;
        if (!inRange) {
            if (ok) {
                inRange = true;
                zMin = z;
            }
        } else {
            if (!ok) {
                zMax = z - 0.5;
                break;
            }
        }
    }
    if (zMin === null) {
        return {x: 0, z: 0};
    }
    if (zMax === null) {
        console.log("Failed to compute range / Z scan didn't finish; setting max value");
        zMax = 150 - 0.5;
    }
    return {
        x: res.xMax - res.xMin, xMin: res.xMin, xMax: res.xMax,
        z: zMax - zMin, zMin, zMax,
    };
}

function angleBetween(v1, v2) {
    const a = v1.angleTo(v2);
    if (a < Math.PI / 2) {
        return a;
    } else {
        return Math.PI - a;
    }
}

function solveFK() {
    // V2.x : Z, V2.y : X
    const p1 = new THREE.Vector2(mech.z1, 0);
    const p2 = new THREE.Vector2(mech.z2, 0);
    const p3 = new THREE.Vector2(mech.z3, 0);
    const eL = solveTriangle(p1, linkLength, p2, linkLength, eLPrev || new THREE.Vector2(50, -50));
    if (eL === null) {
        return null;
    }
    eLPrev = eL;

    const eR = solveTriangle(eL, effectorLength, p3, linkLength, eRPrev || new THREE.Vector2(70, -30));
    if (eR === null || eR.y > 0 || eR.x < eL.x) {
        return null;
    }
    eRPrev = eR;

    const railAxial = new THREE.Vector2(1, 0);
    const minAngle = Math.min(
        angleBetween(railAxial, eL.clone().sub(p1)),
        angleBetween(railAxial, eL.clone().sub(p2)),
        angleBetween(railAxial, eR.clone().sub(p3)),
        angleBetween(eL.clone().sub(p1), eL.clone().sub(p2)),
        //angleBetween(eL.clone().sub(p1), eR.clone().sub(eL)),
        //angleBetween(eL.clone().sub(p2), eR.clone().sub(eL)),
        angleBetween(eR.clone().sub(p3), eR.clone().sub(eR)),
    );

    const railEndMargin = Math.min(
        mech.z1,
        mech.z2,
        mech.z3,
        railLength - mech.z1,
        railLength - mech.z2,
        railLength - mech.z3,
    );

    return {
        effZ: eL.x,
        effX: eL.y,
        effA: eR.clone().sub(eL).angle(),

        l1Z: p1.x,
        l1A: eL.clone().sub(p1).angle(),
        l2Z: p2.x,
        l2A: eL.clone().sub(p2).angle(),
        l3Z: p3.x,
        l3A: eR.clone().sub(p3).angle(),

        links: [
            { p: p1, q: eL },
            { p: p2, q: eL },
            { p: p3, q: eR },
            { p: eL, q: eR },
        ],

        minAngle: minAngle,
        railEndMargin,
    };
}

// Finds a find that's lenP from p, and lenQ from q.
// If multiple solutions exists, return the one closest to near.
// If no solution exists, return null.
// p, q, near: THREE.Vector2
// lenP, lenQ: number
function solveTriangle(p, lenP, q, lenQ, near) {
    const d = q.clone().sub(p).length();
    if (lenP + lenQ < d || Math.abs(lenP - lenQ) > d) return null;

    const a = (lenP * lenP - lenQ * lenQ + d * d) / (2 * d);
    const h = Math.sqrt(lenP * lenP - a * a);

    const pq = q.clone().sub(p).normalize();
    const perpendicular = new THREE.Vector2(-pq.y, pq.x);

    const midpoint = p.clone().add(pq.clone().multiplyScalar(a));
    const sol1 = midpoint.clone().add(perpendicular.clone().multiplyScalar(h));
    const sol2 = midpoint.clone().sub(perpendicular.clone().multiplyScalar(h));

    return sol1.distanceTo(near) < sol2.distanceTo(near) ? sol1 : sol2;
}


////////////////////////////////////////////////////////////////////////////////
// 3D view

function box(sx, sy, sz, hue, opacity) {
    if (opacity === undefined) {
        opacity = 1;
    }
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 0.5, 0.3) });
    if (opacity < 1) {
        mat.transparent = true;
        mat.opacity = opacity;
    }
    return new THREE.Mesh(geom, mat);
}

function cylinder(dia, h, hue) {
    const r = dia / 2;
    const geom = new THREE.CylinderGeometry(r, r, h, 32);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue, 0.5, 0.3) });
    return new THREE.Mesh(geom, mat);
}


/**
 * Scene is in mm unit. Right-handed, Z+ up.
 */
class View3D {
    constructor() {
        this.init();
    }

    init() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const aspect = width / height;
        this.camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, -500, 500);
        this.camera.position.x = -15;
        this.camera.position.y = -40;
        this.camera.position.z = 20;
        this.camera.up.set(0, 0, 1);

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

        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.setupMech();

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');

        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
    }

    setupMech() {
        const waterRailMargin = 20;
        const railDiameter = 6;
        const railDistance = 20;

        // cf. THK LM6 / https://www.monotaro.com/p/0723/1542/
        const lbLength = 19;
        const lbDiameter = 12;

        const col = new THREE.Color("skyblue");
        const water = new THREE.GridHelper(railLength, 25, col, col);
        this.scene.add(water);
        water.rotateX(Math.PI / 2);
        water.position.x = railLength / 2;
        water.position.z = -waterRailMargin;

        const slider1 = cylinder(lbDiameter, lbLength, 0.1);
        const slider2 = cylinder(lbDiameter, lbLength, 0.2);
        const slider3 = cylinder(lbDiameter, lbLength, 0.3);

        this.scene.add(slider1);
        this.scene.add(slider2);
        this.scene.add(slider3);
        slider1.rotateZ(Math.PI / 2);
        slider2.rotateZ(Math.PI / 2);
        slider3.rotateZ(Math.PI / 2);
        slider3.position.y = 20;

        this.slider1 = slider1;
        this.slider2 = slider2;
        this.slider3 = slider3;

        const link1Raw = box(linkLength, 3, 3, 0.12);
        const link1 = new THREE.Object3D();
        link1.add(link1Raw);
        link1Raw.position.x = linkLength / 2;
        const link2Raw = box(linkLength, 3, 3, 0.22);
        const link2 = new THREE.Object3D();
        link2.add(link2Raw);
        link2Raw.position.x = linkLength / 2;
        const link3Raw = box(linkLength, 3, 3, 0.32);
        const link3 = new THREE.Object3D();
        link3.add(link3Raw);
        link3Raw.position.x = linkLength / 2;
        link3.position.y = 20;

        const effRaw = box(effectorLength, 5, 5, 0.5);
        const eff = new THREE.Object3D();
        eff.add(effRaw);
        effRaw.position.x = effectorLength / 2;

        const spindle = box(60, 20, 60, 0.6, 0.3);
        eff.add(spindle);
        spindle.position.y = -10;
        spindle.position.z = 30;
        spindle.position.x = 25;
        spindle.rotateY(-spindleSlant / 180 * Math.PI);

        const tool = cylinder(2, 30, 0.7);
        spindle.add(tool);
        tool.rotateZ(Math.PI / 2);
        //tool.rotateX(Math.PI / 2);
        tool.position.z = -30;
        tool.position.x = -45;

        const rail1 = cylinder(railDiameter, railLength, 0.08);
        this.scene.add(rail1);
        rail1.rotateZ(Math.PI / 2);
        rail1.position.x = railLength / 2;

        const rail2 = cylinder(railDiameter, railLength, 0.28);
        this.scene.add(rail2);
        rail2.rotateZ(Math.PI / 2);
        rail2.position.y = railDistance;
        rail2.position.x = railLength / 2;
        
        this.scene.add(link1);
        this.scene.add(link2);
        this.scene.add(link3);
        this.scene.add(eff);
        this.link1 = link1;
        this.link2 = link2;
        this.link3 = link3;
        this.eff = eff;
    }

    onWindowResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }

    animate() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}

////////////////////////////////////////////////////////////////////////////////
// GUI


function initGui(view) {
    const gui = new GUI();

    gui.add(mech, "z1", 0, railLength).step(0.1).listen().decimals(3).onChange(() => updateFK());
    gui.add(mech, "z2", 0, railLength).step(0.1).listen().decimals(3).onChange(() => updateFK());
    gui.add(mech, "z3", 0, railLength).step(0.1).listen().decimals(3).onChange(() => updateFK());
    
    gui.add(mech, "compute");

    gui.add(mech, "toolBaseZ", 0, 150).listen().decimals(3).onChange(() => updateIK());
    gui.add(mech, "toolBaseX", 0, 100).listen().decimals(3).onChange(() => updateIK());
    gui.add(mech, "toolAngle", 0, 90).listen().decimals(3).onChange(() => updateIK());

    gui.add(mech, "minAngle").listen();
    gui.add(mech, "usableX").listen();
    gui.add(mech, "usableZ").listen();
}


////////////////////////////////////////////////////////////////////////////////
// entry point
const view = new View3D();
initGui(view);

function updateFK() {
    const positions = solveFK();
    if (positions === null) {
        return false;
    }

    mech.toolBaseZ = positions.effZ;
    mech.toolBaseX = positions.effX + railHeightX;
    mech.toolAngle = (spindleSlant + 90 + positions.effA  * 180 / Math.PI + 90) % 360 - 180;
    mech.minAngle = positions.minAngle * 180 / Math.PI;

    view.slider1.position.x = positions.l1Z;
    view.slider2.position.x = positions.l2Z;
    view.slider3.position.x = positions.l3Z;

    view.link1.position.x = positions.l1Z;
    view.link1.setRotationFromEuler(new THREE.Euler(0, -positions.l1A, 0));
    view.link2.position.x = positions.l2Z;
    view.link2.setRotationFromEuler(new THREE.Euler(0, -positions.l2A, 0));
    view.link3.position.x = positions.l3Z;
    view.link3.setRotationFromEuler(new THREE.Euler(0, -positions.l3A, 0));

    view.eff.position.x = positions.effZ;
    view.eff.position.z = positions.effX;
    view.eff.setRotationFromEuler(new THREE.Euler(0, -positions.effA, 0));

    return true;
}

function updateIK() {
    solveIK();
    updateFK();
}

updateFK(); // Initial render
