import { describe, expect, it } from 'vitest';
import { DEFAULT_YAW, FACE_YAW_LIMIT, faceYaw, nearestDefaultYaw } from './AvatarViewer';

describe('yaw on face close-ups', () => {
  it('keeps a small turn the user made', () => {
    expect(faceYaw(DEFAULT_YAW + 30)).toBe(DEFAULT_YAW + 30);
    expect(faceYaw(DEFAULT_YAW - FACE_YAW_LIMIT)).toBe(DEFAULT_YAW - FACE_YAW_LIMIT);
  });

  it('turns V back to the camera from a profile or back view, by the shortest way', () => {
    expect(faceYaw(DEFAULT_YAW + 90)).toBe(DEFAULT_YAW);
    expect(faceYaw(DEFAULT_YAW + 180)).toBe(DEFAULT_YAW + 360);
    expect(faceYaw(DEFAULT_YAW + 620)).toBe(DEFAULT_YAW + 720);
    expect(faceYaw(DEFAULT_YAW + 700)).toBe(DEFAULT_YAW + 700);
    expect(nearestDefaultYaw(DEFAULT_YAW - 200)).toBe(DEFAULT_YAW - 360);
  });
});
