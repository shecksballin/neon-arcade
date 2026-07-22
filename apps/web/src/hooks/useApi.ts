import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  authApi, 
  matchApi, 
  cashOutApi, 
  friendsApi, 
  messagesApi, 
  notificationsApi, 
  profileApi, 
  giftApi, 
  reportApi 
} from '../lib/api';
import type { GameMode } from '@neon/types';

// ==========================================
// AUTH & PROFILE
// ==========================================

export function useAuth() {
  return useQuery({
    queryKey: ['me'],
    queryFn: authApi.me,
    // retry: false is already default globally, this will fail fast without backend
  });
}

export function useProfile(wallet: string) {
  return useQuery({
    queryKey: ['profile', wallet],
    queryFn: () => profileApi.get(wallet),
    enabled: !!wallet,
  });
}

export function useLeaderboard(mode: '1v1' | 'ffa' | 'server') {
  return useQuery({
    queryKey: ['leaderboard', mode],
    queryFn: () => profileApi.leaderboard(mode),
  });
}

// ==========================================
// MATCH & LOBBIES
// ==========================================

export function useMatch(matchId: string) {
  return useQuery({
    queryKey: ['match', matchId],
    queryFn: () => matchApi.get(matchId),
    enabled: !!matchId,
  });
}

export function useCreateMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { mode: GameMode; betAmount: number; maxPlayers: number; region?: string }) => 
      matchApi.create(data.mode, data.betAmount, data.maxPlayers, data.region),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] })
  });
}

export function useJoinMatch() {
  return useMutation({
    mutationFn: (data: { matchId: string; nonce: string }) => 
      matchApi.join(data.matchId, data.nonce),
  });
}

export function useResignMatch() {
  return useMutation({
    mutationFn: (matchId: string) => matchApi.resign(matchId),
  });
}

// CASH OUT
export function useManualCashOut() {
  return useMutation({
    mutationFn: (matchId: string) => cashOutApi.manual(matchId),
  });
}

export function useSetAutoCashOut() {
  return useMutation({
    mutationFn: (data: { matchId: string; kills?: number | null; minutes?: number | null; sol?: number | null }) => 
      cashOutApi.setAuto(data.matchId, data.kills, data.minutes, data.sol),
  });
}

// ==========================================
// FRIENDS & SOCIAL
// ==========================================

export function useFriends() {
  return useQuery({
    queryKey: ['friends'],
    queryFn: friendsApi.list,
  });
}

export function useAddFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wallet: string) => friendsApi.send(wallet),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['friends'] }),
  });
}

export function useAcceptFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wallet: string) => friendsApi.accept(wallet),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['friends'] }),
  });
}

export function useRemoveFriend() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wallet: string) => friendsApi.remove(wallet),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['friends'] }),
  });
}

export function useDuelFriend() {
  return useMutation({
    mutationFn: (data: { wallet: string; betAmount: number }) => 
      friendsApi.duel(data.wallet, data.betAmount),
  });
}

export function useInviteFriend() {
  return useMutation({
    mutationFn: (data: { wallet: string; matchId: string }) => 
      friendsApi.invite(data.wallet, data.matchId),
  });
}

// ==========================================
// MESSAGES
// ==========================================

export function useMessages(withWallet: string) {
  return useQuery({
    queryKey: ['messages', withWallet],
    queryFn: () => messagesApi.get(withWallet),
    enabled: !!withWallet,
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { toWallet: string; body: string }) => 
      messagesApi.send(data.toWallet, data.body),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.toWallet] });
    }
  });
}

// ==========================================
// NOTIFICATIONS
// ==========================================

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: notificationsApi.list,
  });
}

export function useUnreadNotificationsCount() {
  return useQuery({
    queryKey: ['notifications', 'unreadCount'],
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 30000, // Poll every 30s
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    }
  });
}

// ==========================================
// GIFTS & REPORTS
// ==========================================

export function useSendGift() {
  return useMutation({
    mutationFn: (data: { toWallet: string; amountSol: number; txSig: string; nonce: string }) => 
      giftApi.send(data.toWallet, data.amountSol, data.txSig, data.nonce),
  });
}

export function useSubmitReport() {
  return useMutation({
    mutationFn: (data: { type: string; body: string; reportedWallet?: string; matchId?: string }) => 
      reportApi.submit(data.type, data.body, data.reportedWallet, data.matchId),
  });
}
