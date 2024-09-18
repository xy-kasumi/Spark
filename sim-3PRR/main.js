import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const linkLength = 50;
const effectorLength = 25;

let eLPrev = null;
let eRPrev = null;

let chart = null;

const mech = {
    z1: 30,
    z2: 40,
    z3: 60,
    samples: [],
    reset: () => {
        mech.samples = [];
        chart.series[0].setData([]);
    },
    play: () => {
        execStep();
    },
};


function computePositions() {
    // V2.x : Z, V2.y : X
    const p1 = new THREE.Vector2(mech.z1, 0);
    const p2 = new THREE.Vector2(mech.z2, 0);
    const p3 = new THREE.Vector2(mech.z3, 0);
    const eL = solveTriangle(p1, linkLength, p2, linkLength, eLPrev || new THREE.Vector2(50, -50));
    if (eL === null) {
        return { links: [] };
    }
    eLPrev = eL;

    const eR = solveTriangle(eL, effectorLength, p3, linkLength, eRPrev || new THREE.Vector2(50, -50));
    if (eR === null || eR.y > 0 || eR.x < eL.x) {
        return { links: [] };
    }
    eRPrev = eR;

    const delta = eR.clone().sub(eL).normalize();

    mech.samples.push({
        z1: mech.z1,
        z2: mech.z2,
        z3: mech.z3,
        x: eL.x,
        y: eL.y,
        t: Math.atan2(delta.y, delta.x) * 180 / Math.PI,
    });

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


const playN = 25;
let playIx0 = 0;
let playIx1 = 0;

function execStep() {
    mech.z1 = 30;
    mech.z3 = 1 + 140 * (playIx0 / playN);
    mech.z2 = 31 + 140 * (playIx1 / playN);
    const success = update();
    if (success) {
        playIx0++;
    } else {
        playIx0 = 0;
        playIx1++;
    }

    if (playIx0 >= playN) {
        playIx0 = 0;
        playIx1++;
    }
    if (playIx1 >= playN) {
        playIx1 = 0;
        return;
    }
    setTimeout(execStep, 5);
}


Highcharts.setOptions({
    colors: [
        'rgba(5,141,199,0.5)'
    ]
});


function refreshChart(samples) {
    if (!chart) {
        return;
    }
    //chart.series[0].setData(samples.map(s => [s.t, s.y]));
    const s = samples[samples.length - 1];
    chart.series[0].addPoint([s.t, s.y]);
}

const series = [{
    name: 'TY',
    id: 'TY',
    marker: {
        symbol: 'circle'
    }
},];

chart = Highcharts.chart('container', {
    chart: {
        type: 'scatter',
        zooming: {
            type: 'xy'
        },
    },
    title: {
        text: 'Output Space',
    },
    xAxis: {
        title: {
            text: 'θ'
        },
        labels: {
            format: '{value}°'
        },
        min: -120,
        max: 120,
        startOnTick: true,
        endOnTick: true,
        showLastLabel: true
    },
    yAxis: {
        title: {
            text: 'Y'
        },
        labels: {
            format: '{value} mm'
        },
        min: -60,
        max: -20,
    },
    legend: {
        enabled: true
    },
    plotOptions: {
        scatter: {
            marker: {
                radius: 2.5,
                symbol: 'circle',
                states: {
                    hover: {
                        enabled: true,
                        lineColor: 'rgb(100,100,100)'
                    }
                }
            },
            states: {
                hover: {
                    marker: {
                        enabled: false
                    }
                }
            },
            jitter: {
                x: 0.005
            }
        }
    },
    series
});


////////////////////////////////////////////////////////////////////////////////
// 3D view

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
        this.camera = new THREE.OrthographicCamera(-50 * aspect, 50 * aspect, 50, -50, 1, 500);
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


        const gridHelperBottom = new THREE.GridHelper(100, 10);
        this.scene.add(gridHelperBottom);
        gridHelperBottom.rotateX(Math.PI / 2);

        const axesHelper = new THREE.AxesHelper(8);
        this.scene.add(axesHelper);
        axesHelper.position.set(-19, -19, 0);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        const geom = new THREE.CylinderGeometry(5, 5, 8, 32);
        
        const mat1 = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.1, 0.5, 0.3) });
        const mat2 = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.2, 0.5, 0.3) });
        const mat3 = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.3, 0.5, 0.3) });
        const slider1 = new THREE.Mesh(geom, mat1);
        const slider2 = new THREE.Mesh(geom, mat2);
        const slider3 = new THREE.Mesh(geom, mat3);
        this.scene.add(slider1);
        this.scene.add(slider2);
        this.scene.add(slider3);
        slider1.rotateZ(Math.PI / 2);
        slider2.rotateZ(Math.PI / 2);
        slider3.rotateZ(Math.PI / 2);

        this.slider1 = slider1;
        this.slider2 = slider2;
        this.slider3 = slider3;

        const geomLink = new THREE.BoxGeometry(linkLength, 3, 3);
        const geomEff = new THREE.BoxGeometry(effectorLength, 5, 5);

        const link1Raw = new THREE.Mesh(geomLink, mat1);
        const link1 = new THREE.Object3D();
        link1.add(link1Raw);
        link1Raw.position.x = linkLength / 2;
        const link2Raw = new THREE.Mesh(geomLink, mat2);
        const link2 = new THREE.Object3D();
        link2.add(link2Raw);
        link2Raw.position.x = linkLength / 2;
        const link3Raw = new THREE.Mesh(geomLink, mat3);
        const link3 = new THREE.Object3D();
        link3.add(link3Raw);
        link3Raw.position.x = linkLength / 2;

        const effRaw = new THREE.Mesh(geomEff, new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0.5, 0.5, 0.3) }));
        const eff = new THREE.Object3D();
        eff.add(effRaw);
        effRaw.position.x = effectorLength / 2;
        
        this.scene.add(link1);
        this.scene.add(link2);
        this.scene.add(link3);
        this.scene.add(eff);
        this.link1 = link1;
        this.link2 = link2;
        this.link3 = link3;
        this.eff = eff;

        const guiStatsEl = document.createElement('div');
        guiStatsEl.classList.add('gui-stats');


        window.addEventListener('resize', () => this.onWindowResize());
        Object.assign(window, { scene: this.scene });
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

    gui.add(mech, "z1", 0, 150).step(0.1).onChange(() => update());
    gui.add(mech, "z2", 0, 150).step(0.1).onChange(() => update());
    gui.add(mech, "z3", 0, 150).step(0.1).onChange(() => update());
    
    gui.add(mech, "reset");
    gui.add(mech, "play");
}


////////////////////////////////////////////////////////////////////////////////
// entry point
const view = new View3D();
initGui(view);

function update() {
    const positions = computePositions();
    if (positions.links.length === 0) {
        return false;
    }

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

    refreshChart(mech.samples);
    return true;
}

update(); // Initial render
