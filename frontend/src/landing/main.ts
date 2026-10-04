/** Landing page behaviour: hero console readouts, colour mode, nav, section reveal. */
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './landing.css'
import { drawStep, mount } from './hero.js'

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!

function startHero() {
  const log = $('#log')
  const con = $('#console')
  const ess = $('#ro-ess')
  const sup = $('#ro-sup')
  const uns = $('#ro-uns')
  let last = ''

  const hero = mount($<SVGSVGElement>('[data-parallel-hero]'), {
    interactive: true,
    par: 'xMidYMid meet',
    onCaption(text) {
      if (text === last) return
      last = text
      const [head, ...rest] = text.split(' · ')
      const li = document.createElement('li')
      const b = document.createElement('b')
      b.textContent = head
      li.append(b, rest.length ? ` · ${rest.join(' · ')}` : '')
      if (head === 't+0') log.replaceChildren()
      log.append(li)
      while (log.children.length > 4) log.firstChild?.remove()
    },
    onTick(m) {
      sup.textContent = `${m.supply} kW`
      uns.textContent = `${m.unserved} kW`
      uns.className = `v${m.unserved > 0 ? ' bad' : ''}`
      ess.textContent = `${(Math.round(m.essential * 1000) / 10).toFixed(1).replace(/\.0$/, '')}%`
      ess.className = `v${m.essential >= 0.999 ? ' ok' : m.essential < 0.85 ? ' bad' : ''}`
      $('#c-ok').textContent = String(m.ok)
      $('#c-red').textContent = String(m.reduced)
      $('#c-dark').textContent = String(m.dark)
    },
    onPause: (paused) => con.classList.toggle('paused', paused),
  })
  $('#reset').addEventListener('click', () => hero.reset())
  // Same handle the original page exposed, for driving the hero from the browser console.
  Object.assign(window, { parallelHero: hero })

  document.querySelectorAll<SVGSVGElement>('[data-parallel-step]').forEach((svg) => drawStep(svg, Number(svg.dataset.parallelStep)))
}

function startTheme() {
  const root = document.documentElement
  const btn = $<HTMLButtonElement>('#theme')
  const current = () => root.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  const label = () => {
    btn.textContent = current() === 'dark' ? 'Light' : 'Dark'
  }
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark'
    root.setAttribute('data-theme', next)
    try {
      localStorage.setItem('parallel-theme', next)
    } catch {
      // Private windows can refuse storage. The choice still holds for this visit.
    }
    label()
  })
  label()
}

function startNav() {
  const nav = $('#nav')
  const hero = $<HTMLElement>('.hero')
  const cta = $<HTMLAnchorElement>('.nav-cta')
  const onScroll = () => {
    const past = window.scrollY > hero.offsetHeight - 120
    nav.classList.toggle('past', past)
    cta.tabIndex = past ? 0 : -1
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()
}

function startReveal() {
  const pending = new Set(document.querySelectorAll('.reveal'))
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    pending.forEach((e) => e.classList.add('in'))
    return
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        entry.target.classList.add('in')
        observer.unobserve(entry.target)
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  )
  pending.forEach((e) => observer.observe(e))
}

startHero()
startTheme()
startNav()
startReveal()
