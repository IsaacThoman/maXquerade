import * as THREE from 'three'

export interface StatsData {
  position: THREE.Vector3
  velocity?: THREE.Vector3
  grounded?: boolean
  sliding?: boolean
  fps?: number
}

/**
 * A debug overlay that displays player stats on screen.
 * Can be extended to show additional game statistics.
 */
export class StatsOverlay {
  private container: HTMLElement
  private coordsElement: HTMLElement
  private velocityElement: HTMLElement | null = null
  private stateElement: HTMLElement | null = null
  private fpsElement: HTMLElement | null = null

  constructor(parent: HTMLElement, options: { showVelocity?: boolean; showState?: boolean; showFPS?: boolean } = {}) {
    this.container = document.createElement('div')
    this.container.className = 'stats-overlay'

    // Coordinates display
    this.coordsElement = document.createElement('div')
    this.coordsElement.className = 'stats-row'
    this.container.appendChild(this.coordsElement)

    // Optional velocity display
    if (options.showVelocity) {
      this.velocityElement = document.createElement('div')
      this.velocityElement.className = 'stats-row'
      this.container.appendChild(this.velocityElement)
    }

    // Optional state display (grounded, sliding, etc.)
    if (options.showState) {
      this.stateElement = document.createElement('div')
      this.stateElement.className = 'stats-row'
      this.container.appendChild(this.stateElement)
    }

    // Optional FPS display
    if (options.showFPS) {
      this.fpsElement = document.createElement('div')
      this.fpsElement.className = 'stats-row'
      this.container.appendChild(this.fpsElement)
    }

    parent.appendChild(this.container)
  }

  /**
   * Update the overlay with the latest stats.
   * Call this every frame in the game loop.
   */
  update(data: StatsData): void {
    const { position, velocity, grounded, sliding } = data

    // Format coordinates to 2 decimal places
    const x = position.x.toFixed(2)
    const y = position.y.toFixed(2)
    const z = position.z.toFixed(2)
    this.coordsElement.innerHTML = `<span class="stats-label">pos</span> <span class="stats-value">x:${x} y:${y} z:${z}</span>`

    // Update velocity if enabled
    if (this.velocityElement && velocity) {
      const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z).toFixed(1)
      const vx = velocity.x.toFixed(1)
      const vy = velocity.y.toFixed(1)
      const vz = velocity.z.toFixed(1)
      this.velocityElement.innerHTML = `<span class="stats-label">vel</span> <span class="stats-value">x:${vx} y:${vy} z:${vz}</span> <span class="stats-speed">(${speed})</span>`
    }

    // Update state if enabled
    if (this.stateElement) {
      const states: string[] = []
      if (grounded) states.push('grounded')
      if (sliding) states.push('sliding')
      if (states.length === 0) states.push('airborne')
      this.stateElement.innerHTML = `<span class="stats-label">state</span> <span class="stats-state">${states.join(' | ')}</span>`
    }

    // Update FPS if enabled
    if (this.fpsElement && data.fps !== undefined) {
      this.fpsElement.innerHTML = `<span class="stats-label">fps</span> <span class="stats-value">${data.fps.toFixed(1)}</span>`
    }
  }

  /**
   * Remove the overlay from the DOM and clean up.
   */
  destroy(): void {
    this.container.remove()
  }
}
