export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      comments: {
        Row: {
          body: string
          created_at: string
          household_id: string
          id: string
          member_id: string | null
          proposal_id: string
        }
        Insert: {
          body: string
          created_at?: string
          household_id: string
          id?: string
          member_id?: string | null
          proposal_id: string
        }
        Update: {
          body?: string
          created_at?: string
          household_id?: string
          id?: string
          member_id?: string | null
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_proposal_id_household_id_fkey"
            columns: ["proposal_id", "household_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      dishes: {
        Row: {
          cook_minutes: number | null
          created_at: string
          created_by: string | null
          description: string | null
          household_id: string
          id: string
          image_url: string | null
          prep_minutes: number | null
          source_url: string | null
          tags: string[]
          title: string
          total_minutes: number | null
        }
        Insert: {
          cook_minutes?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          household_id: string
          id?: string
          image_url?: string | null
          prep_minutes?: number | null
          source_url?: string | null
          tags?: string[]
          title: string
          total_minutes?: number | null
        }
        Update: {
          cook_minutes?: number | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          household_id?: string
          id?: string
          image_url?: string | null
          prep_minutes?: number | null
          source_url?: string | null
          tags?: string[]
          title?: string
          total_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "dishes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dishes_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      households: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          timezone: string
          week_start_day: number
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          timezone?: string
          week_start_day?: number
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          timezone?: string
          week_start_day?: number
        }
        Relationships: []
      }
      invites: {
        Row: {
          consumed_at: string | null
          consumed_by: string | null
          created_at: string
          created_by: string
          expires_at: string
          household_id: string
          id: string
          token: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          created_by: string
          expires_at?: string
          household_id: string
          id?: string
          token: string
        }
        Update: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          created_by?: string
          expires_at?: string
          household_id?: string
          id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "invites_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          avatar: string | null
          created_at: string
          display_name: string
          household_id: string
          id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          avatar?: string | null
          created_at?: string
          display_name: string
          household_id: string
          id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          avatar?: string | null
          created_at?: string
          display_name?: string
          household_id?: string
          id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "members_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          created_at: string
          dish_id: string
          household_id: string
          id: string
          note: string | null
          proposed_by: string | null
          week_id: string
        }
        Insert: {
          created_at?: string
          dish_id: string
          household_id: string
          id?: string
          note?: string | null
          proposed_by?: string | null
          week_id: string
        }
        Update: {
          created_at?: string
          dish_id?: string
          household_id?: string
          id?: string
          note?: string | null
          proposed_by?: string | null
          week_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposals_dish_id_household_id_fkey"
            columns: ["dish_id", "household_id"]
            isOneToOne: false
            referencedRelation: "dishes"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "proposals_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_week_id_household_id_fkey"
            columns: ["week_id", "household_id"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      reactions: {
        Row: {
          created_at: string
          household_id: string
          id: string
          kind: string
          member_id: string
          proposal_id: string
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          kind: string
          member_id: string
          proposal_id: string
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          kind?: string
          member_id?: string
          proposal_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reactions_member_id_household_id_fkey"
            columns: ["member_id", "household_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "reactions_proposal_id_household_id_fkey"
            columns: ["proposal_id", "household_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      slot_dishes: {
        Row: {
          created_at: string
          dish_id: string
          household_id: string
          id: string
          position: number
          prep_minutes_override: number | null
          slot_id: string
        }
        Insert: {
          created_at?: string
          dish_id: string
          household_id: string
          id?: string
          position?: number
          prep_minutes_override?: number | null
          slot_id: string
        }
        Update: {
          created_at?: string
          dish_id?: string
          household_id?: string
          id?: string
          position?: number
          prep_minutes_override?: number | null
          slot_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "slot_dishes_dish_id_household_id_fkey"
            columns: ["dish_id", "household_id"]
            isOneToOne: false
            referencedRelation: "dishes"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "slot_dishes_slot_id_household_id_fkey"
            columns: ["slot_id", "household_id"]
            isOneToOne: false
            referencedRelation: "slots"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      slots: {
        Row: {
          created_at: string
          day_of_week: number
          household_id: string
          id: string
          meal_type: Database["public"]["Enums"]["meal_type"]
          position: number
          week_id: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          household_id: string
          id?: string
          meal_type: Database["public"]["Enums"]["meal_type"]
          position?: number
          week_id: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          household_id?: string
          id?: string
          meal_type?: Database["public"]["Enums"]["meal_type"]
          position?: number
          week_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "slots_week_id_household_id_fkey"
            columns: ["week_id", "household_id"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      weeks: {
        Row: {
          created_at: string
          household_id: string
          id: string
          start_date: string
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          start_date: string
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          start_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "weeks_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_invite: {
        Args: { p_display_name: string; p_token: string }
        Returns: string
      }
      consume_invite: { Args: { p_token: string }; Returns: string }
      create_household: {
        Args: { p_display_name: string; p_name: string }
        Returns: string
      }
      current_household_id: { Args: never; Returns: string }
      is_household_owner: { Args: never; Returns: boolean }
    }
    Enums: {
      meal_type: "breakfast" | "lunch" | "dinner" | "snack"
      member_role: "owner" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      meal_type: ["breakfast", "lunch", "dinner", "snack"],
      member_role: ["owner", "member"],
    },
  },
} as const

