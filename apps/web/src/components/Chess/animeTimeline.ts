import { createTimeline } from 'animejs';

export const playCaptureSequence = (
  attackerRef: HTMLElement, 
  targetRef: HTMLElement, 
  boardRef: HTMLElement, 
  targetX: number, 
  targetY: number, 
  currentX: number, 
  currentY: number
) => {
  const captureTimeline = createTimeline();

  captureTimeline
    // 1. Wind-Up
    .add(attackerRef, {
      translateX: currentX - (targetX - currentX) * 0.15,
      translateY: currentY - (targetY - currentY) * 0.15,
      duration: 100,
      ease: 'outQuad'
    })
    // 2. The Strike
    .add(attackerRef, {
      translateX: targetX,
      translateY: targetY,
      duration: 200,
      ease: 'outExpo' 
    })
    // 3. The Impact (Starts before strike finishes using '-=150')
    .add(targetRef, {
      scale: [1, 0],
      rotate: '1turn',
      opacity: [1, 0],
      duration: 250,
      ease: 'inBack',
    }, '-=150');
};
