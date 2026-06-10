import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { isMultiUserEnabled } from '@/lib/multi-user';
import { UsersClient } from './UsersClient';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  // The dashboard layout already gated admin access, but if a non admin route
  // collision ever lands here we don't want to leak user data.
  if (!(await isMultiUserEnabled())) notFound();

  const users = await prisma.user.findMany({
    orderBy: [{ isAdmin: 'desc' }, { username: 'asc' }],
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true,
      isAdmin: true,
      createdAt: true,
      _count: { select: { queries: true } },
    },
  });

  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Users</h1>
      <UsersClient
        initialUsers={users.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatar: u.avatar,
          isAdmin: u.isAdmin,
          createdAt: u.createdAt.toISOString(),
          queryCount: u._count.queries,
        }))}
      />
    </div>
  );
}
