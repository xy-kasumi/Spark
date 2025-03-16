# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq

def make_spring(length=10, half_width=4, height=4, thickness=0.8, approx_half_pitch=2.5):
    """
    Make spring that stretches in X direction.
    Printable in Z direction.
    
    Half pitch will be changed to match length.
    
    X: [-thickness/2, length + thickness/2]
    Y: [-half_width, half_width]
    Z: [0, height]
    """
    num_segs = round(length / approx_half_pitch)
    half_pitch = length / num_segs

    spring = cq.Workplane("XY")
    
    half_len_straight = half_width - half_pitch / 2 - thickness / 2
    if half_len_straight <= 0:
        raise ValueError("Spring width too small compared to thickness & pitch")
    
    for i in range(num_segs):
        sign = 1 if i % 2 == 0 else -1
        spring = (
            spring
            .moveTo(-thickness / 2, 0)
            .vLineTo(sign * half_len_straight)
            .threePointArc(
                (half_pitch / 2, sign * half_width),
                (half_pitch + thickness / 2, sign * half_len_straight))
            .vLineTo(0)
            .hLineTo(half_pitch - thickness / 2)
            .vLineTo(sign * half_len_straight)
            .threePointArc(
                (half_pitch / 2, sign * (half_width - thickness)),
                (thickness / 2, sign * half_len_straight))
            .vLineTo(0)
            .close()
            .center(half_pitch, 0)
        )
    
    spring = spring.extrude(height)
    return spring


def make_din_clip(l_end_offset=20, r_end_offset=20, top_th=5):
    """
    l_end_offset: left (x-) end position relative to rail center
    r_end_offset: right (x+) endposition relative to rail center
    
    left end has release knob
    usable area will be l_end_offset + r_end_offset
    Z=0 will be rail top plane.
    clip width (spans in Y direction symmetrically) will be always 10mm.
    
    """
    rail_width = 35
    rail_t = 1.1
    # right side
    frame_th = 3
    notch_th = 2
    notch_height = 2
    notch_shift = .5
    # left side
    end_tab_len = 5
    end_tab_th = 4
    spring_len = 15
    spring_height = 4
    spring_th = 3
    spring_notch_height = rail_t * 0.4
    
    body = (
        cq.Workplane("XZ")
        # left (X-) side
        .moveTo(-rail_width / 2, 0)
        .vLine(-rail_t * 0.2)
        # spring loop
        .hLine(-spring_len)
        .vLine(-spring_height)
        .hLine(spring_len - 4)
        .vLine(-spring_th)
        .hLine(-spring_len + 4)
        .hLine(-spring_th)
        .hLineTo(-l_end_offset)
        .vLineTo(top_th)
        .hLineTo(0)
        # right (X+) side
        .hLineTo(r_end_offset)
        .vLine(-top_th)
        .hLineTo(rail_width / 2 + frame_th)
        .vLineTo(-(rail_t + notch_shift + notch_th ))
        .hLine(-notch_height-frame_th)
        .vLine(notch_th)
        .line(notch_height, notch_shift)
        .vLine(rail_t)
        .lineTo(0, 0)
        .close()
        .extrude(5, both=True)
    )
    
    spring = (
        make_spring(length=spring_len-4, half_width=spring_height * 0.5 - 0.4, thickness=0.6, height=10, approx_half_pitch=2)
        .translate((0, 0, -5))
        .rotateAboutCenter((1, 0, 0), 90)
        .translate((-spring_len - rail_width / 2, 0, -spring_height * 0.5 + 0.2 - rail_t * 0.2))
    )
    
    clip = (
        cq.Workplane("XZ")
        .center(-rail_width/2 - 2, -rail_t * 0.2 - spring_height / 2)
        .rect(6, spring_height - 0.3)
        .extrude(5, both=True)
        .edges("<Z and >X")
        .chamfer(1, 2)
        .edges(">Z and >X")
        .chamfer(.5, 1)
    )
    
    lever = (
        cq.Workplane("XZ")
        .moveTo(-l_end_offset - end_tab_len, -9.5)
        .hLineTo(-rail_width/2)
        .vLine(7)
        .hLine(-3)
        .vLine(-5)
        .hLineTo(-l_end_offset - end_tab_len)
        .close()
        .extrude(5, both=True)
        .faces("<Z")
        .workplane()
        .center(-l_end_offset - 1.5, 0)
        .rect(3, 5)
        .cutThruAll()
    )
    
    return body.union(spring).union(clip).union(lever)


def make_din_clip_holes(hole_offsets, dia_hole, l_end=20, r_end=20):
    """
    Generate din clip with holes for inserting capbolts from the back side.
    """
    thickness = 5
    clip = make_din_clip(l_end, r_end, thickness)
    points = [(ofs, 0) for ofs in hole_offsets]
    clip = (
        clip.faces(">Z").workplane(origin=(0,0,0), offset=thickness, invert=True)
        .pushPoints(points)
        .hole(dia_hole)
    )
    
    return clip

def make_din_clip_inserts():
    """
    Generate din clip with two holes for screwing from the front side.
    """
    pass
