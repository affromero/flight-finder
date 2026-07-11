import { vi } from 'vitest';
import { createTranslator } from 'next-intl';
import common from '../../messages/en/common.json';
import components from '../../messages/en/components.json';
import pages from '../../messages/en/pages.json';
import settings from '../../messages/en/settings.json';
import admin from '../../messages/en/admin.json';

const messages = { ...common, ...components, ...pages, ...settings, ...admin };

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  return {
    ...actual,
    useTranslations: (namespace?: string) =>
      createTranslator({ locale: 'en', messages, namespace: namespace as never }),
    useLocale: () => 'en',
  };
});

vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return {
    ...actual,
    getTranslations: async (opts?: string | { namespace?: string }) => {
      const namespace = typeof opts === 'string' ? opts : opts?.namespace;
      return createTranslator({ locale: 'en', messages, namespace: namespace as never });
    },
    getLocale: async () => 'en',
    getMessages: async () => messages,
  };
});
