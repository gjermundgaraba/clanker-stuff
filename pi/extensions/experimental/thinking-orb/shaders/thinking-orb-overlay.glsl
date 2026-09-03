// Native-resolution Thinking Orb overlay for Ghostty.
// Orbit design derived from thinking-orbs by Jakub Antalik; see
// THIRD_PARTY_NOTICES.md in this directory.
//
// The companion Pi extension places a sparse transparent coordinate texture
// over one pane. This shader derives pane-local coordinates from its marker
// pairs, restores those pixels, then additively composites the orb over the
// untouched terminal image.
//
// custom-shader = /absolute/path/to/thinking-orb-overlay.glsl
// custom-shader-animation = false

const float PI = 3.141592653589793;
const float TAU = 6.283185307179586;
const float CONTROL_PERIOD = 8.0;
const float COORDINATE_RANGE = 8.0;

int controlBytes(vec3 color, out float coordinate) {
  ivec3 bytes = ivec3(floor(color * 255.0 + 0.5));
  coordinate =
    float(bytes.g * 256 + bytes.b) /
      65535.0 *
      (COORDINATE_RANGE * 2.0) -
    COORDINATE_RANGE;
  if (bytes.r == 248) {
    return 1;
  }
  if (bytes.r == 249) {
    return 2;
  }
  return 0;
}

vec3 linearToSrgb(vec3 color) {
  vec3 low = color * 12.92;
  vec3 high = 1.055 * pow(max(color, vec3(0.0)), vec3(1.0 / 2.4)) -
    0.055;
  return mix(high, low, lessThanEqual(color, vec3(0.0031308)));
}

bool decodedControl(
  vec3 color,
  int expectedRole,
  out float coordinate
) {
  int role = controlBytes(color, coordinate);
  if (role == expectedRole) {
    return true;
  }

  // Ghostty's Kitty image path and the custom-shader target may use different
  // color spaces. Convert sampled linear light back to bytes, then allow the
  // small tag drift caused by the display color profile. The expected role is
  // already known from the marker's position, so the overlapping ranges are
  // intentional.
  vec3 srgb = linearToSrgb(color);
  ivec3 bytes = ivec3(floor(srgb * 255.0 + 0.5));
  bool tagMatches =
    (expectedRole == 1 &&
      (bytes.r == 248 || (bytes.r >= 235 && bytes.r <= 241))) ||
    (expectedRole == 2 &&
      (bytes.r == 249 || (bytes.r >= 240 && bytes.r <= 245)));
  if (!tagMatches) {
    coordinate = 0.0;
    return false;
  }

  coordinate =
    float(bytes.g * 256 + bytes.b) /
      65535.0 *
      (COORDINATE_RANGE * 2.0) -
    COORDINATE_RANGE;
  return true;
}

bool controlSample(
  vec2 pixelCenter,
  int expectedRole,
  out float coordinate
) {
  if (
    pixelCenter.x < 0.5 ||
    pixelCenter.y < 0.5 ||
    pixelCenter.x > iResolution.x - 0.5 ||
    pixelCenter.y > iResolution.y - 0.5
  ) {
    coordinate = 0.0;
    return false;
  }

  vec3 color = texture(iChannel0, pixelCenter / iResolution.xy).rgb;
  return decodedControl(color, expectedRole, coordinate);
}

bool panePoint(
  vec2 fragCoord,
  out vec2 point,
  out float pixel,
  out bool controlPixel
) {
  vec2 tileCenter =
    floor(fragCoord / CONTROL_PERIOD) * CONTROL_PERIOD + 0.5;
  float xCoordinate = 0.0;
  float yCoordinate = 0.0;
  bool valid =
    controlSample(tileCenter, 1, xCoordinate) &&
    controlSample(tileCenter + vec2(1.0, 0.0), 2, yCoordinate);
  if (!valid) {
    point = vec2(0.0);
    pixel = 0.0;
    controlPixel = false;
    return false;
  }

  float neighborX = 0.0;
  if (
    controlSample(
      tileCenter + vec2(CONTROL_PERIOD, 0.0),
      1,
      neighborX
    )
  ) {
    pixel = (neighborX - xCoordinate) / CONTROL_PERIOD;
  } else if (
    controlSample(
      tileCenter - vec2(CONTROL_PERIOD, 0.0),
      1,
      neighborX
    )
  ) {
    pixel = (xCoordinate - neighborX) / CONTROL_PERIOD;
  } else {
    point = vec2(0.0);
    pixel = 0.0;
    controlPixel = false;
    return false;
  }

  pixel = abs(pixel);
  if (pixel < 0.000001 || pixel > 0.25) {
    point = vec2(0.0);
    pixel = 0.0;
    controlPixel = false;
    return false;
  }

  // Ghostty's Metal custom-shader coordinate system has downward Y, matching
  // the coordinate texture's top-to-bottom source rows.
  point = vec2(
    xCoordinate + (fragCoord.x - tileCenter.x) * pixel,
    yCoordinate - (fragCoord.y - tileCenter.y) * pixel
  );
  vec2 pixelIndex = floor(fragCoord);
  vec2 tileIndex = floor(tileCenter);
  controlPixel =
    pixelIndex.y == tileIndex.y &&
    (pixelIndex.x == tileIndex.x || pixelIndex.x == tileIndex.x + 1.0);
  return true;
}

void orbitData(
  int index,
  out vec3 firstAxis,
  out vec3 secondAxis,
  out float radius,
  out float speed,
  out float phase
) {
  if (index == 0) {
    firstAxis = vec3(-0.52681571, 0.84997954, 0.0);
    secondAxis = vec3(0.29618488, 0.18357483, 0.93732321);
    radius = 0.93587718;
    speed = -0.42459485;
    phase = 4.48138976;
  } else if (index == 1) {
    firstAxis = vec3(-0.94882993, 0.31578754, 0.0);
    secondAxis = vec3(0.06524998, 0.19605312, 0.97841996);
    radius = 0.92121720;
    speed = -0.45729836;
    phase = 5.78506241;
  } else if (index == 2) {
    firstAxis = vec3(-0.55837618, 0.82958788, 0.0);
    secondAxis = vec3(-0.12648079, -0.08513126, 0.98830930);
    radius = 0.46521591;
    speed = 0.62951029;
    phase = 4.65554511;
  } else if (index == 3) {
    firstAxis = vec3(0.98986188, -0.14203331, 0.0);
    secondAxis = vec3(0.01926541, 0.13426494, 0.99075818);
    radius = 0.64652129;
    speed = 0.78072443;
    phase = 0.05785874;
  } else if (index == 4) {
    firstAxis = vec3(0.40780657, -0.91306834, 0.0);
    secondAxis = vec3(-0.60189369, -0.26882566, 0.75196859);
    radius = 0.77331527;
    speed = 0.54601256;
    phase = 2.08002681;
  } else if (index == 5) {
    firstAxis = vec3(0.30023961, -0.95386381, 0.0);
    secondAxis = vec3(-0.14582986, -0.04590163, 0.98824425);
    radius = 0.72330662;
    speed = -0.35009110;
    phase = 2.10986980;
  } else if (index == 6) {
    firstAxis = vec3(-0.19858723, 0.98008322, 0.0);
    secondAxis = vec3(0.92409454, 0.18724265, 0.33315083);
    radius = 0.86759017;
    speed = -0.43711853;
    phase = 3.19847851;
  } else if (index == 7) {
    firstAxis = vec3(-0.64714207, -0.76236942, 0.0);
    secondAxis = vec3(0.49663124, -0.42156855, 0.75870770);
    radius = 0.64009229;
    speed = 0.61572444;
    phase = 4.47297502;
  } else if (index == 8) {
    firstAxis = vec3(0.16071893, -0.98700021, 0.0);
    secondAxis = vec3(-0.25232684, -0.04108783, 0.96676934);
    radius = 0.73166446;
    speed = -0.46857859;
    phase = 2.53386559;
  } else if (index == 9) {
    firstAxis = vec3(0.79383818, 0.60812905, 0.0);
    secondAxis = vec3(0.56558955, -0.73830806, 0.36743664);
    radius = 0.85951380;
    speed = 0.77871833;
    phase = 2.12494431;
  } else if (index == 10) {
    firstAxis = vec3(0.51616225, 0.85649082, 0.0);
    secondAxis = vec3(0.21707591, -0.13082031, 0.96734900);
    radius = 0.94543144;
    speed = 0.77789698;
    phase = 1.50207289;
  } else {
    firstAxis = vec3(0.92532245, -0.37918119, 0.0);
    secondAxis = vec3(-0.06448920, -0.15737411, 0.98543114);
    radius = 0.74535029;
    speed = -0.36237451;
    phase = 0.26447534;
  }
}

void projectAxis(
  vec3 point,
  float yawCosine,
  float yawSine,
  out vec2 screenPoint,
  out float depth
) {
  float yawX = point.x * yawCosine + point.z * yawSine;
  float yawZ = -point.x * yawSine + point.z * yawCosine;
  const float pitchCosine = 0.95533649;
  const float pitchSine = 0.29552021;
  float pitchY = point.y * pitchCosine - yawZ * pitchSine;
  depth = point.y * pitchSine + yawZ * pitchCosine;
  screenPoint = vec2(yawX, -pitchY);
}

float disc(float distanceFromCenter, float radius, float antialias) {
  return 1.0 - smoothstep(
    max(0.0, radius - antialias),
    radius + antialias,
    distanceFromCenter
  );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec4 base = texture(iChannel0, fragCoord / iResolution.xy);
  vec2 point;
  float pixel;
  bool controlPixel;
  if (!panePoint(fragCoord, point, pixel, controlPixel)) {
    fragColor = base;
    return;
  }

  // Only two of every sixty-four pixels carry opaque coordinate data. Recover
  // those pixels from their transparent vertical neighbors; every other
  // terminal pixel reaches the overlay bit-for-bit unchanged.
  vec3 surface = base.rgb;
  if (controlPixel) {
    vec3 previous = texture(
      iChannel0,
      (fragCoord - vec2(0.0, 1.0)) / iResolution.xy
    ).rgb;
    vec3 next = texture(
      iChannel0,
      (fragCoord + vec2(0.0, 1.0)) / iResolution.xy
    ).rgb;
    surface = (previous + next) * 0.5;
  }

  // The terminal remains bit-for-bit unchanged outside the orb.
  if (length(point) > 0.64) {
    fragColor = vec4(surface, base.a);
    return;
  }

  vec3 light = vec3(0.0);
  float renderedSize = 1.36 / pixel;
  float dotScale = pow(max(renderedSize, 1.0) / 300.0, 0.6);
  float antialias = pixel * 0.72;
  float time = iTime * 0.45;
  float yaw = time * 0.12;
  float yawCosine = cos(yaw);
  float yawSine = sin(yaw);
  vec3 trackInk = vec3(0.50, 0.66, 0.93);
  vec3 particleInk = vec3(0.76, 0.86, 1.0);

  for (int orbit = 0; orbit < 12; orbit++) {
    vec3 firstAxis;
    vec3 secondAxis;
    float radiusFactor;
    float angularSpeed;
    float phase;
    orbitData(
      orbit,
      firstAxis,
      secondAxis,
      radiusFactor,
      angularSpeed,
      phase
    );

    float radius = 0.56 * radiusFactor;
    vec2 firstScreen;
    vec2 secondScreen;
    float firstDepth;
    float secondDepth;
    projectAxis(
      firstAxis * radius,
      yawCosine,
      yawSine,
      firstScreen,
      firstDepth
    );
    projectAxis(
      secondAxis * radius,
      yawCosine,
      yawSine,
      secondScreen,
      secondDepth
    );

    // Transform this fragment into the circle's two-dimensional basis, find
    // the nearest of forty angular samples, then measure from that sample's
    // exact screen-space center. The final SDF is a true circle, so even the
    // smallest track particles stay round on oblique ellipses.
    float determinant =
      firstScreen.x * secondScreen.y -
      firstScreen.y * secondScreen.x;
    float safeDeterminant =
      (determinant < 0.0 ? -1.0 : 1.0) *
      max(abs(determinant), 0.000001);
    vec2 circleCoordinate =
      vec2(
        secondScreen.y * point.x - secondScreen.x * point.y,
        -firstScreen.y * point.x + firstScreen.x * point.y
      ) /
      safeDeterminant;
    float coordinateLength = max(length(circleCoordinate), 0.000001);
    vec2 circleUnit = circleCoordinate / coordinateLength;
    float angle = atan(circleUnit.y, circleUnit.x);
    const float dotSpacing = TAU / 40.0;
    float dotAngle =
      mod(angle + dotSpacing * 0.5 + PI, dotSpacing) -
      dotSpacing * 0.5;
    float dotAngleSquared = dotAngle * dotAngle;
    float dotCosine =
      1.0 -
      dotAngleSquared * 0.5 +
      dotAngleSquared * dotAngleSquared / 24.0;
    float dotSine = dotAngle * (1.0 - dotAngleSquared / 6.0);
    vec2 dotUnit =
      vec2(
        circleUnit.x * dotCosine + circleUnit.y * dotSine,
        -circleUnit.x * dotSine + circleUnit.y * dotCosine
      );
    vec2 trackPosition =
      firstScreen * dotUnit.x + secondScreen * dotUnit.y;
    float trackDistance = length(point - trackPosition);
    float trackRadius = max(0.85, 0.9 * dotScale) * pixel;
    float trackCore = disc(trackDistance, trackRadius, antialias);
    float trackGlow = exp(
      -trackDistance * trackDistance /
        max(trackRadius * trackRadius * 5.5, 0.0000001)
    );
    float trackDepth =
      clamp(
        (firstDepth * dotUnit.x + secondDepth * dotUnit.y) /
          radius *
          0.5 +
          0.5,
        0.0,
        1.0
      );
    float edgeOn = smoothstep(
      0.045,
      0.10,
      abs(determinant) / max(radius * radius, 0.000001)
    );
    float trackAmount =
      (trackCore + trackGlow * 0.08) *
      (0.12 + 0.22 * trackDepth) *
      edgeOn;
    light += trackInk * trackAmount;

    float particleAngle = time * angularSpeed + phase;
    float particleCosine = cos(particleAngle);
    float particleSine = sin(particleAngle);
    for (int particle = 0; particle < 3; particle++) {
      float cosine = particleCosine;
      float sine = particleSine;
      if (particle == 1) {
        cosine = -0.5 * particleCosine - 0.8660254 * particleSine;
        sine = 0.8660254 * particleCosine - 0.5 * particleSine;
      } else if (particle == 2) {
        cosine = -0.5 * particleCosine + 0.8660254 * particleSine;
        sine = -0.8660254 * particleCosine - 0.5 * particleSine;
      }

      vec2 particlePosition =
        firstScreen * cosine + secondScreen * sine;
      float particleDepth =
        clamp(
          (firstDepth * cosine + secondDepth * sine) / radius * 0.5 +
            0.5,
          0.0,
          1.0
        );
      float particleRadius =
        (1.2 + 1.6 * particleDepth) * dotScale * pixel;
      float particleDistance = length(point - particlePosition);
      float particleCore = disc(
        particleDistance,
        particleRadius,
        antialias
      );
      float particleGlow = exp(
        -particleDistance * particleDistance /
          max(particleRadius * particleRadius * 6.5, 0.0000001)
      );
      float particleAmount =
        particleCore * (0.62 + 0.32 * particleDepth) +
        particleGlow * (0.055 + 0.075 * particleDepth);
      light += particleInk * particleAmount;
    }
  }

  // Soft highlight compression keeps overlapping particles round instead of
  // clipping them into hard, misshapen white blobs. Only the orb's emitted
  // light is screen-composited over the untouched terminal pixel.
  vec3 color = 1.0 - (1.0 - surface) * exp(-light);
  fragColor = vec4(color, base.a);
}
