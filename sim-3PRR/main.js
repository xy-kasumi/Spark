import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.168.0/+esm";

const canvas = document.getElementById('mechanismCanvas');
const canvasIn = document.getElementById('inputSpaceCanvas');
const canvasOut = document.getElementById('outputSpaceCanvas');

const sliders = [
    document.getElementById('slider1'),
    document.getElementById('slider2'),
    document.getElementById('slider3')
];

const linkLength = 50;
const effectorLength = 25;

let eLPrev = null;
let eRPrev = null;
const samples = [];

function computePositions(inputs) {
    const p1 = new THREE.Vector2(inputs[0], 0);
    const p2 = new THREE.Vector2(inputs[1], 0);
    const p3 = new THREE.Vector2(inputs[2], 0);
    const eL = solveTriangle(p1, linkLength, p2, linkLength, eLPrev || new THREE.Vector2(50, 50));
    eLPrev = eL;
    if (eL === null) {
        return {links: []};
    }
    const eR = solveTriangle(eL, effectorLength, p3, linkLength, eRPrev || new THREE.Vector2(50, 50));
    eRPrev = eR;
    if (eR === null) {
        return {links: []};
    }

    const delta = eR.clone().sub(eL).normalize();

    samples.push({
        i0: inputs[0],
        i1: inputs[1],
        i2: inputs[2],
        x: eL.x,
        y: eL.y,
        t: Math.atan2(delta.y, delta.x) * 180 / Math.PI,
    });

    return {
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

function render(positions) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    try {
        ctx.save();

        ctx.scale(1, -1);
        ctx.translate(0, -canvas.height);
        ctx.scale(4, 4);

        ctx.fillStyle = 'black';
        ctx.strokeStyle = 'black';
        positions.links.forEach(link => {
            ctx.beginPath();
            ctx.moveTo(link.p.x, link.p.y);
            ctx.lineTo(link.q.x, link.q.y);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(link.p.x, link.p.y, 2, 0, 2 * Math.PI);
            ctx.fill();

            ctx.beginPath();
            ctx.arc(link.q.x, link.q.y, 2, 0, 2 * Math.PI);
            ctx.fill();
        });
    }
    finally {
        ctx.restore();
    }
}


function renderOutput(samples) {
    const ctx = canvasOut.getContext('2d');
    ctx.clearRect(0, 0, canvasOut.width, canvasOut.height);

    ctx.fillStyle = 'black';
    console.log(samples);
    samples.forEach(sample => {
        
        ctx.beginPath();
        ctx.arc(sample.y + 100, sample.t / 180 * 100 + 100, 1, 0, 2 * Math.PI);
        ctx.fill();
    });
}


function renderInput(samples) {
    const ctx = canvasIn.getContext('2d');
    ctx.clearRect(0, 0, canvasIn.width, canvasIn.height);

    ctx.fillStyle = 'black';
    console.log(samples);
    samples.forEach(sample => {
        
        ctx.beginPath();
        ctx.arc(sample.i1 + 100, sample.i2 + 100, 1, 0, 2 * Math.PI);
        ctx.fill();
    });
}

function update() {
    const inputs = sliders.map(slider => parseFloat(slider.value));
    const positions = computePositions(inputs);
    render(positions);
    renderInput(samples);
    renderOutput(samples);
}

sliders.forEach(slider => slider.addEventListener('input', update));
update(); // Initial render

document.getElementById("resetButton").addEventListener("click", () => {
    samples.clear();
});

const playN = 30;
let playIx0 = 0;
let playIx1 = 0;

function execStep() {
    sliders[1].value = 11 + 90 * (playIx0 / playN);
    sliders[2].value = 11 + 90 * (playIx1 / playN);
    update();

    playIx0++;
    if (playIx0 >= playN) {
        playIx0 = 0;
        playIx1++;
        if (playIx1 >= playN) {
            playIx1 = 0;
            return;
        }
    }
    setTimeout(execStep, 5);
}

document.getElementById("playButton").addEventListener("click", () => {
    execStep();
});
