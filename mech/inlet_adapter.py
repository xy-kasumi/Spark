# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq

clearance = 5
hole_dist = 58

def make_inlet_adapter():
    return (
        cq.Workplane("XY")
        .rect(20, 68)
        .extrude(45)
        # mount hole
        .faces(">X")
        .workplane()
        .center(0, 22.5)
        .rect(40, 27)
        .cutThruAll()
        # inlet clearance
        .faces("<X")
        .workplane(invert=True)
        .rect(40 + clearance * 2, 27 + clearance * 2)
        .cutBlind(20 - 3)
        # mounting hole
        .faces("<Z")
        .workplane()
        .center(10, 0)
        .pushPoints([(0, -hole_dist/2), (0, hole_dist/2)])
        .hole(3.3)
        # material reduction
        .faces(">Z")
        .workplane(invert=True)
        .center(-4, 0)
        .rect(16, 70)
        .cutBlind(41)
    )

# show_object(make_inlet_adapter())
