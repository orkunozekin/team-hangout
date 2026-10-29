import React from 'react';
import Svg, { Circle, Line, Rect } from 'react-native-svg';

import type { SportPreset, SurfaceSize } from '../lib/coaching/lineupSurface';

/** Decorative sport markings. Positions are always also exposed through an accessible list. */
export default function SurfaceMarkings({ preset, frame }: { preset: SportPreset; frame: SurfaceSize }) {
  const strokeWidth = 2;
  return (
    <Svg width={frame.width} height={frame.height} pointerEvents="none" accessibilityElementsHidden>
      <Rect x={1} y={1} width={frame.width - 2} height={frame.height - 2} rx={16} fill={preset.surfaceColor} stroke={preset.lineColor} strokeWidth={strokeWidth} />
      {preset.id === 'football' ? (
        <>
          {[0.2, 0.4, 0.6, 0.8].map((ratio) => <Line key={ratio} x1={frame.width * ratio} x2={frame.width * ratio} y1={8} y2={frame.height - 8} stroke={preset.lineColor} strokeWidth={1} />)}
          <Line x1={frame.width / 2} x2={frame.width / 2} y1={2} y2={frame.height - 2} stroke={preset.lineColor} strokeWidth={strokeWidth} />
        </>
      ) : (
        <>
          <Line x1={2} x2={frame.width - 2} y1={frame.height / 2} y2={frame.height / 2} stroke={preset.lineColor} strokeWidth={strokeWidth} />
          <Circle cx={frame.width / 2} cy={frame.height / 2} r={Math.min(frame.width, frame.height) * 0.13} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
          {preset.id === 'soccer' ? (
            <>
              <Rect x={frame.width * 0.22} y={2} width={frame.width * 0.56} height={frame.height * 0.13} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
              <Rect x={frame.width * 0.22} y={frame.height * 0.87} width={frame.width * 0.56} height={frame.height * 0.13 - 2} fill="none" stroke={preset.lineColor} strokeWidth={strokeWidth} />
            </>
          ) : null}
        </>
      )}
    </Svg>
  );
}
