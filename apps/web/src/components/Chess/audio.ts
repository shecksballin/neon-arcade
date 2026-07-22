import { Howl } from 'howler';

class ChessAudioEngine {
  private enabled: boolean = true;
  private whiteMoveSound: Howl;
  private blackMoveSound: Howl;
  private captureSound: Howl;
  private checkSound: Howl;

  constructor() {
    this.whiteMoveSound = new Howl({
      src: ['/whitemove.wav'],
      volume: 1.0,
      preload: true,
    });

    this.blackMoveSound = new Howl({
      src: ['/blackmove.wav'],
      volume: 1.0,
      preload: true,
    });

    this.captureSound = new Howl({
      src: ['/captureSoundfx.wav'],
      volume: 1.0,
      preload: true,
    });

    this.checkSound = new Howl({
      src: ['/newchecksoundfx.wav'],
      volume: 1.0,
      preload: true,
    });
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  public playMove(color: 'w' | 'b') {
    if (!this.enabled) return;
    if (color === 'w') {
      this.whiteMoveSound.play();
    } else {
      this.blackMoveSound.play();
    }
  }

  public playCapture(color: 'w' | 'b') {
    if (!this.enabled) return;
    this.captureSound.play();
  }

  public playCheck(color: 'w' | 'b') {
    if (!this.enabled) return;
    this.checkSound.play();
  }

  public playCastle(color: 'w' | 'b') {
    if (!this.enabled) return;
    if (color === 'w') {
      this.whiteMoveSound.play();
    } else {
      this.blackMoveSound.play();
    }
  }

  public playPromotion(color: 'w' | 'b') {
    if (!this.enabled) return;
    if (color === 'w') {
      this.whiteMoveSound.play();
    } else {
      this.blackMoveSound.play();
    }
  }

  public playCheckmate() {
    if (!this.enabled) return;
    // Just a placeholder, we play the white move sound
    this.whiteMoveSound.play();
  }
}

export const chessAudio = new ChessAudioEngine();

