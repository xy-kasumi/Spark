import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.168.0/+esm";

const canvas = document.getElementById('mechanismCanvas');
const ctx = canvas.getContext('2d');
const sliders = [
    document.getElementById('slider1'),
    document.getElementById('slider2'),
    document.getElementById('slider3')
];

const linkLength = 50;
const effectorLength = 25;

function computePositions(inputs) {
    const p1 = new THREE.Vector2(inputs[0], 0);
    const p2 = new THREE.Vector2(inputs[1], 0);
    const p3 = new THREE.Vector2(inputs[2], 0);
    const eL = solveTriangle(p1, linkLength, p2, linkLength, new THREE.Vector2(50, 50));
    if (eL === null) {
        return {links: []};
    }
    const eR = solveTriangle(eL, effectorLength, p3, linkLength, new THREE.Vector2(50, 50));
    if (eR === null) {
        return {links: []};
    }

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

function update() {
    const inputs = sliders.map(slider => parseFloat(slider.value));
    const positions = computePositions(inputs);
    render(positions);
}

sliders.forEach(slider => slider.addEventListener('input', update));
update(); // Initial render