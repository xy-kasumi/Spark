# SPDX-License-Identifier: CERN-OHL-S-2.0
import cadquery as cq

def make_din_clip(l_end_offset=20, r_end_offset=20):
    """
    l_end_offset: left (x-) end position relative to rail center
    r_end_offset: right (x+) endposition relative to rail center
    
    left end has release knob
    usable area will be l_end_offset + r_end_offset
    """
    rail_width = 35
    rail_t = 1.1
    notch_height = 2
    notch_shift = .5
    top_th = 5
    # right side
    frame_th = 3
    notch_th = 2
    # left side
    spring_gap = 1
    spring_depth = 2
    end_tab_len = 4
    end_tab_th = 3
    
    result = (
        cq.Workplane("XZ")
        # left (X-) side
        .moveTo(-rail_width / 2 + spring_gap, 0)
        .vLine(spring_depth)
        .hLine(-spring_gap)
        .vLine(-spring_depth)
        .vLine(-rail_t)
        .line(notch_height * 0.5, -notch_shift * 0.5)
        .vLine(-5)
        .hLineTo(-l_end_offset)
        # end tab
        .hLine(-end_tab_len)
        .vLine(end_tab_th)
        .hLine(end_tab_len)
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
        # left hole
        .center(-rail_width / 2, 0)
        .moveTo(-1, spring_depth)
        .hLine(-spring_gap)
        .vLine(-spring_depth)
        .hLineTo(-(l_end_offset - rail_width / 2) + 1)
        .vLine(-3)
        .hLineTo(-1)
        .close()
        #.rect(-(l_end_offset - rail_width / 2 - 2), -4, centered=False)
        .extrude(10)
    )
    return result

show_object(make_din_clip(30, 50))
