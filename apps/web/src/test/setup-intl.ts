import { vi } from 'vitest';
import { createTranslator } from 'next-intl';
import common from '../../messages/en/common.json';
import components from '../../messages/en/components.json';
import pages from '../../messages/en/pages.json';
import settings from '../../messages/en/settings.json';
import admin from '../../messages/en/admin.json';
import hotels from '../../messages/en/hotels.json';

const messages = { ...common, ...components, ...pages, ...settings, ...admin, ...hotels };

const translator = (namespace?: string) =>
  createTranslator({ locale: 'en', messages, namespace: namespace as never });

vi.mock('next-intl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl')>();
  return {
    ...actual,
    useTranslations: (namespace?: string) => translator(namespace),
    useLocale: () => 'en',
  };
});

vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return {
    ...actual,
    getTranslations: async (opts?: string | { namespace?: string }) =>
      translator(typeof opts === 'string' ? opts : opts?.namespace),
    getLocale: async () => 'en',
    getMessages: async () => messages,
  };
});
