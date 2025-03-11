# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq

foot_sz = 20
foot_thickness = 5
foot_len = 120
notch_thickness = 10
m3_insert_dia = 5.1
m3_hole_dia = 3.3
m3_cap_dia = 8

def make_foot():
    foot = (
        cq.Workplane("XZ")
        .hLine(foot_sz)
        .vLine(-foot_thickness)
        .hLine(-(foot_sz + foot_thickness))
        .vLine((foot_sz + foot_thickness))
        .hLine(foot_thickness)
        .vLineTo(0)
        .close()
        .extrude(-foot_len)
    )
    
    notch1 = (
        cq.Workplane("XZ", origin=(foot_sz/2, 7, foot_sz/2))
        .rect(foot_sz, foot_sz)
        .extrude(-notch_thickness)
        .faces("<Y")
        .hole(m3_insert_dia)
    )
    
    notch2 = (
        cq.Workplane("XZ", origin=(foot_sz/2, 57, foot_sz/2))
        .rect(foot_sz, foot_sz)
        .extrude(-notch_thickness)
        .faces("<Y")
        .cboreHole(m3_hole_dia, m3_cap_dia, 6)
    )

    return foot.union(notch1).union(notch2)
        

result = make_foot()
