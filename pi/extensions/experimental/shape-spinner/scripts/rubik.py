"""Build-time Rubik's cube scene.

Twenty-six cubies preserve 54 sticker identities through five quarter-turns
and their exact inverse. This is original sticker artwork, not an Amp shape.
All timing is sampled at integer 20ms ticks (50fps), retaining the 4.4s cycle.
"""
import io
import math
from itertools import product

from PIL import Image, ImageDraw

FPS = 50
# Ghostty fits the fixed color-glyph bounds into the two reserved cells. A
# square canvas uses their nearly square physical viewport without distortion.
UPM = 1000
ASCENT = 800
DESCENT = -200
SUPERSAMPLE = 4
YAW = 0.58
PITCH = -0.43
# Right, left, top, bottom, back, front. Flat, saturated fills stay legible
# at terminal sizes; narrow dark gutters separate each face's nine stickers.
COLORS = (
    (0.94, 0.22, 0.20),
    (1.00, 0.49, 0.08),
    (0.94, 0.96, 1.00),
    (1.00, 0.82, 0.08),
    (0.12, 0.75, 0.36),
    (0.10, 0.43, 0.98),
)
NORMALS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
SCRAMBLE = ((0, 1, 1), (1, 1, -1), (2, -1, 1), (0, 1, -1), (1, 1, 1))
SOLVE = tuple(
    (axis, layer, -direction) for axis, layer, direction in reversed(SCRAMBLE)
)
# Scramble turns take 0.2 seconds; solving keeps its readable 0.5-second turns.
# The two solved holds join into 0.7 seconds before the next quick scramble.
TIMELINE = (
    ((None, 20),)
    + tuple((move, 10) for move in SCRAMBLE)
    + ((None, 10),)
    + tuple((move, 25) for move in SOLVE)
    + ((None, 15),)
)
FRAME_COUNT = sum(length for _, length in TIMELINE)
# Authoring stays solved-first so geometry, glyph order and PNGs remain stable.
# Playback begins at the scrambled hold, then solves before scrambling again.
PLAYBACK_START = sum(length for _, length in TIMELINE[: 1 + len(SCRAMBLE)])
SOLVED_START = sum(length for _, length in TIMELINE[:-1])
STILL = (SOLVED_START - PLAYBACK_START) % FRAME_COUNT


def rotate(point, axis, angle):
    x, y, z = point
    c, s = math.cos(angle), math.sin(angle)
    return (
        (x, y * c - z * s, y * s + z * c),
        (x * c + z * s, y, -x * s + z * c),
        (x * c - y * s, x * s + y * c, z),
    )[axis]


def quarter(point, axis, direction):
    return tuple(round(v) for v in rotate(point, axis, direction * math.pi / 2))


def ease(t):
    # Cosine acceleration over 16% at each end, constant velocity in between.
    ramp = 0.16
    velocity = 1 / (1 - ramp)
    if t < ramp:
        return velocity * (t / 2 - ramp * math.sin(math.pi * t / ramp) / (2 * math.pi))
    if t > 1 - ramp:
        return 1 - ease(1 - t)
    return velocity * (t - ramp / 2)


def initial_cubies():
    cubies = []
    for pos in product((-1, 0, 1), repeat=3):
        if pos == (0, 0, 0):
            continue
        # Only sticker normals carry identity; body turns just permute NORMALS.
        stickers = tuple(
            (normal, color)
            for color, normal in enumerate(NORMALS)
            if sum(a * b for a, b in zip(pos, normal)) == 1
        )
        cubies.append((pos, stickers))
    return cubies


def apply_move(cubies, move):
    axis, layer, direction = move
    return [
        (
            quarter(position, axis, direction),
            tuple(
                (quarter(normal, axis, direction), color) for normal, color in stickers
            ),
        )
        if position[axis] == layer
        else (position, stickers)
        for position, stickers in cubies
    ]


def pose(frame):
    cubies = initial_cubies()
    frame %= FRAME_COUNT
    for move, length in TIMELINE:
        if frame < length:
            return cubies, move, ease(frame / length) if move else 0
        if move:
            cubies = apply_move(cubies, move)
        frame -= length
    raise AssertionError("unreachable frame")


def camera(point):
    return rotate(rotate(point, 1, YAW), 0, PITCH)


def face(center, normal, half, plane):
    # Construct local plane before partial turns; all completed normals remain integral.
    axis = next(i for i, v in enumerate(normal) if v)
    aa, bb = (axis + 1) % 3, (axis + 2) % 3
    points = []
    for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        p = [center[i] + normal[i] * plane for i in range(3)]
        p[aa] += a * half
        p[bb] += b * half
        points.append(tuple(p))
    return points


def raw_scene(frame):
    cubies, move, t = pose(frame)
    out = []
    for pos, stickers in cubies:
        moving = move and pos[move[0]] == move[1]

        def transform(p):
            if moving:
                p = rotate(p, move[0], move[2] * t * math.pi / 2)
            return camera(p)

        for normal, color in [(n, None) for n in NORMALS] + list(stickers):
            normal_view = transform(normal)
            if normal_view[2] >= -1e-8:
                continue
            # Thin black gutters, no dot lattice, gloss, rounded stickers or wiremesh.
            vertices = [
                transform(p)
                for p in face(
                    pos,
                    normal,
                    0.495 if color is None else 0.459,
                    0.495 if color is None else 0.496,
                )
            ]
            if color is None:
                rgb = (0.055, 0.067, 0.085)
            else:
                light = max(0, min(1, normal_view[1] * 0.45 - normal_view[2] * 0.85))
                shade = 0.9 + 0.1 * light
                rgb = tuple(v * shade for v in COLORS[color])
            out.append((vertices, rgb))
    # Opaque faces are backface-culled above, then painted far to near. The
    # sticker plane sits just outside its cubie's body so gutters stay dark.
    out.sort(key=lambda item: -sum(p[2] for p in item[0]) / 4)
    return out


def scenes():
    # Normalize the UNION of every pose once, never individual frame bounds.
    # Mid-turn corners have room to swing without clipping or camera zooms.
    allscenes = [raw_scene(f) for f in range(FRAME_COUNT)]
    xs = [p[0] for sc in allscenes for vs, _ in sc for p in vs]
    ys = [p[1] for sc in allscenes for vs, _ in sc for p in vs]
    extent = max(max(xs) - min(xs), max(ys) - min(ys))
    scale = 940 / extent
    cx = (max(xs) + min(xs)) / 2
    cy = (max(ys) + min(ys)) / 2
    scenes = [
        [
            (
                tuple(
                    (round(500 + (x - cx) * scale, 6), round(300 + (y - cy) * scale, 6))
                    for x, y, z in vs
                ),
                tuple(round(v * 255) for v in rgb),
            )
            for vs, rgb in sc
        ]
        for sc in allscenes
    ]
    return scenes


def raster(scene, ppem):
    im = Image.new("RGBA", (ppem * SUPERSAMPLE, ppem * SUPERSAMPLE))
    draw = ImageDraw.Draw(im)
    for vs, rgb in scene:
        draw.polygon(
            [
                (x * ppem * SUPERSAMPLE / UPM, (ASCENT - y) * ppem * SUPERSAMPLE / UPM)
                for x, y in vs
            ],
            fill=rgb + (255,),
        )
    im = im.resize((ppem, ppem), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    im.save(output, format="PNG", compress_level=9)
    return output.getvalue()


def check_scene(rendered_scenes):
    original = initial_cubies()
    assert len(original) == 26
    assert sum(len(stickers) for _, stickers in original) == 54
    assert all(
        axis in (0, 1, 2) and layer in (-1, 1) and direction in (-1, 1)
        for axis, layer, direction in SCRAMBLE
    )
    cubies = original
    scrambled_states = [original]
    for move in SCRAMBLE:
        cubies = apply_move(cubies, move)
        scrambled_states.append(cubies)
    assert cubies != original
    assert pose(PLAYBACK_START)[0] == cubies
    for index, move in enumerate(SOLVE):
        cubies = apply_move(cubies, move)
        assert cubies == scrambled_states[-2 - index]
    # Every cubie's position and identity-bearing sticker normals return exactly.
    assert cubies == original == pose(FRAME_COUNT - 1)[0] == pose(FRAME_COUNT)[0]
    assert pose((PLAYBACK_START + STILL) % FRAME_COUNT)[0] == original
    assert raw_scene(0) == raw_scene(FRAME_COUNT - 1) == raw_scene(FRAME_COUNT)
    assert raw_scene(0) != raw_scene(PLAYBACK_START)
    assert ease(0) == 0 and ease(1) == 1
    assert all(ease(i / 100) < ease((i + 1) / 100) for i in range(100))
    for scene in rendered_scenes:
        assert scene
        for vertices, rgb in scene:
            assert len(vertices) == 4 and len(rgb) == 3
            assert all(0 <= channel <= 255 for channel in rgb)
            for x, y in vertices:
                assert math.isfinite(x) and math.isfinite(y)
                assert 29 <= x <= UPM - 29
                assert DESCENT + 29 <= y <= ASCENT - 29
