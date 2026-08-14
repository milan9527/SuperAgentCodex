import React from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TranslationProvider } from '@/i18n'
import { TranslationContext, translations } from '@/i18n'
import type { Language } from '@/types'
import { ToastProvider, ErrorBoundary } from '@/components'
import { AuthProvider } from '@/services/AuthContext'
import { FeatureTogglesProvider } from '@/services/FeatureTogglesContext'

// Test wrapper that mimics the App structure but uses MemoryRouter
const AppTestWrapper: React.FC<{ children: React.ReactNode; initialEntries?: string[] }> = ({ 
  children, 
  initialEntries = ['/'] 
}) => {
  return (
    <ErrorBoundary>
      <MemoryRouter initialEntries={initialEntries}>
        <TranslationProvider>
          <ToastProvider>
            <AuthProvider>
              <FeatureTogglesProvider>
                {children}
              </FeatureTogglesProvider>
            </AuthProvider>
          </ToastProvider>
        </TranslationProvider>
      </MemoryRouter>
    </ErrorBoundary>
  )
}

const renderApp = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'> & { initialEntries?: string[] }
) => {
  const { initialEntries, ...renderOptions } = options || {}
  
  return render(ui, { 
    wrapper: ({ children }) => (
      <AppTestWrapper initialEntries={initialEntries}>
        {children}
      </AppTestWrapper>
    ), 
    ...renderOptions 
  })
}

export * from '@testing-library/react'
export function renderWithLanguage(
  ui: React.ReactElement,
  language: Language,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <TranslationContext.Provider
        value={{
          currentLanguage: language,
          setLanguage: () => {},
          t: (key) => translations[key]?.[language] ?? key,
        }}
      >
        {children}
      </TranslationContext.Provider>
    ),
    ...options,
  })
}

export const renderCn = (
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) => renderWithLanguage(ui, 'cn', options)

export { renderApp as render }
