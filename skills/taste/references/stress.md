# Stress data

Feed the UI values that real data allows and real users produce, to find where it breaks before they do.

## Method

- Every value is either realistic or the actual limit the data allows. A field with no limit is itself a finding.
- Feed the data through the same path real data takes: the store, the API, the file, the input. Never edit the UI to force a break.
- Spread different failures across the first visible rows so one capture shows many.
- Keep the data set as a regression fixture where the project has a place for one.
- Rate each break as broken (wrong or unusable), ugly (works but looks wrong), or fragile (holds now, breaks with one more character or item), and list what held up.

## Counts

- None, exactly one (singular wording), exactly a full screen, and one more than fits.
- Items with identical names; every status value in one list; the current user in a list of users.

## Numbers

- Zero, negative, very large, and a live value that gains a digit while shown.
- Percentages below 0 or above 100 on a bar or gauge.
- Thousands and locale separators, and missing values printed literally (null, NaN, undefined).

## Time

- "0 seconds ago", dates in the future, the zero date (1970), and a time that falls on another day in another time zone.
- Durations long enough that they must roll up into hours or days.

## Short and missing values

- A one-character value that leaves a column looking empty.
- An optional field present in some rows and absent in others. Leave the line out rather than showing a placeholder dash.

## Text from users and sources

- Wide characters (CJK takes two cells in a terminal), joined emoji, stacked combining accents clipped by tight rows.
- Strings with no break points: URLs, identifiers, long compound words.
- Translation growth of about a third, and right-to-left text.
- Markup or escape sequences inside data (HTML, ANSI codes in a title) shown as literal text, never interpreted.
- A newline inside a value meant for one line.

## Media

- A missing or failed image, whose fallback takes the same space as the real one.
- Extreme aspect ratios: a panorama, a tall strip, a one-pixel image.

## Environment

- The component reused in a narrower container than it was designed for.
- The user's largest text size or zoom; in a terminal, the smallest window.
- Light and dark themes, reduced motion, increased contrast, and colour turned off.
- Slow, failing, and offline sources, and a response that arrives after the user has moved on.
